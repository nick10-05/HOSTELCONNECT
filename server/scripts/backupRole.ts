import type { ClientBase } from "pg";
import { databaseUrlProblem } from "../src/lib/databaseUrl";

// The nightly backup's login (multi-tenant phase 2d). Migration 018 creates the
// hostel_backup role without a login, since the repository is public and a migration
// file cannot hold a password. scripts/backup-role.ts gives it the password from
// BACKUP_DATABASE_URL, once, with the migration credential (docs/deploy.md).

// Shortest password accepted: the role can read every hostel's rows.
export const MIN_BACKUP_PASSWORD = 20;

// Why BACKUP_DATABASE_URL cannot be the backup's login, or null when it can. Like
// databaseUrlProblem, the message never quotes the URL or any part of it.
export function backupUrlProblem(value: string): string | null {
  const problem = databaseUrlProblem(value);
  if (problem) return `BACKUP_DATABASE_URL ${problem}`;
  const url = new URL(value.trim());
  // Supabase's pooler logs in as "role.projectref", so compare only the part before the dot.
  if (decodeURIComponent(url.username).split(".")[0] !== "hostel_backup") {
    return "BACKUP_DATABASE_URL must log in as hostel_backup (hostel_backup.<project ref> through Supabase's pooler)";
  }
  if (decodeURIComponent(url.password).length < MIN_BACKUP_PASSWORD) {
    return `BACKUP_DATABASE_URL's password must be at least ${MIN_BACKUP_PASSWORD} characters`;
  }
  return null;
}

// The password inside BACKUP_DATABASE_URL (call backupUrlProblem first).
export function backupPassword(value: string): string {
  return decodeURIComponent(new URL(value.trim()).password);
}

// BACKUP_DATABASE_URL ends in ?sslmode=require, which pg_dump reads as "encrypt". The
// Node pg driver reads it as "also verify against the public CAs", which fails for
// Supabase's own CA (docs/deploy.md, step 1), so Node connects with no-verify: still
// encrypted, as the app's own URLs do.
export function forNodePg(value: string): string {
  const url = new URL(value.trim());
  if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "no-verify");
  return url.toString();
}

// Lets hostel_backup log in with `password`. `admin` is a connection as the migration
// role, outside any transaction. The password is handed over as a parameter, never
// spliced into SQL text the server could log, and only for this one transaction.
export async function setBackupLogin(admin: ClientBase, password: string): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT set_config('hostelconnect.backup_password', $1, true)", [password]);
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostel_backup') THEN
          RAISE EXCEPTION 'The hostel_backup role does not exist yet: apply migration 018 first';
        END IF;
        EXECUTE format('ALTER ROLE hostel_backup LOGIN PASSWORD %L',
                       current_setting('hostelconnect.backup_password'));
      END
      $$`);
    await admin.query("COMMIT");
  } catch (err) {
    await admin.query("ROLLBACK");
    throw err;
  }
}

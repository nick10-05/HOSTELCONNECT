import { randomBytes } from "node:crypto";
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

// The nightly backup's login, made by the backup workflow itself (2026-11-13). Setting
// BACKUP_DATABASE_URL by hand (scripts/backup-role.ts) was a step easy to miss, and the
// nightly backup failed until it was done. Now scripts/backup-login.ts gives hostel_backup
// a new random password each night, with the migration credential the workflow already
// has, and locks the role again once the dump is done.

// 24 random bytes as hex: 48 characters, nothing to percent-encode.
export function newBackupPassword(): string {
  return randomBytes(24).toString("hex");
}

// hostel_backup's URL on the same server as the migration URL: Supabase's pooler logs in
// as "role.projectref", so the project ref is kept. sslmode=require is what pg_dump needs
// (forNodePg turns it into no-verify for Node). Errors never quote the URL.
export function backupUrlFrom(migrationUrl: string, password: string): string {
  const problem = databaseUrlProblem(migrationUrl);
  if (problem) throw new Error(`MIGRATION_DATABASE_URL ${problem}`);
  const url = new URL(migrationUrl.trim());
  const ref = decodeURIComponent(url.username).split(".")[1];
  url.username = encodeURIComponent(ref ? `hostel_backup.${ref}` : "hostel_backup");
  url.password = encodeURIComponent(password);
  // A local server without SSL (sslmode=disable) stays without it; anything else encrypts.
  if (url.searchParams.get("sslmode") !== "disable") url.searchParams.set("sslmode", "require");
  return url.toString();
}

// Hides a value in every later line of the GitHub Actions log.
export function maskCommand(value: string): string {
  return `::add-mask::${value}`;
}

// The line for $GITHUB_ENV that hands the URL to the workflow's later steps. A line break
// in the value would let it set another variable, so it is refused.
export function githubEnvLine(url: string): string {
  if (/[\r\n]/.test(url)) throw new Error("The backup URL must be one line");
  return `BACKUP_DATABASE_URL=${url}\n`;
}

// After the backup: hostel_backup can no longer log in, and its password is gone, so the
// night's password is useless even if it leaked. `admin` is the migration role.
export async function lockBackupLogin(admin: ClientBase): Promise<void> {
  await admin.query("ALTER ROLE hostel_backup NOLOGIN PASSWORD NULL");
}

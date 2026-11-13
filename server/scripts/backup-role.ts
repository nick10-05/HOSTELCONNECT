import { Client } from "pg";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { backupPassword, backupUrlProblem, forNodePg, setBackupLogin } from "./backupRole";

// Gives the nightly backup's role, hostel_backup, its login (multi-tenant phase 2d).
// Since 2026-11-13 the backup workflow does this itself on each run
// (scripts/backup-login.ts); this script is only for a dump made by hand elsewhere.
// Run once, after migration 018 is applied, from the server folder:
//   npx tsx scripts/backup-role.ts
// with two variables set in this window only (never saved in .env):
//   MIGRATION_DATABASE_URL  the migration credential, which may change roles
//   BACKUP_DATABASE_URL     the new value of the GitHub secret: hostel_backup's login,
//                           with a new password of at least 20 characters
// It sets the password, then logs in as hostel_backup and reads, as the backup will.
// Running it again sets the password again (to change it). Steps: docs/deploy.md.

async function main() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim() ?? "";
  const backupUrl = process.env.BACKUP_DATABASE_URL?.trim() ?? "";
  const migrationProblem = databaseUrlProblem(migrationUrl);
  if (migrationProblem) throw new Error(`MIGRATION_DATABASE_URL ${migrationProblem}`);
  const problem = backupUrlProblem(backupUrl);
  if (problem) throw new Error(problem);

  const admin = new Client({ connectionString: migrationUrl });
  await admin.connect();
  try {
    await setBackupLogin(admin, backupPassword(backupUrl));
  } finally {
    await admin.end();
  }

  // The same reads pg_dump --enable-row-security makes: every hostel's rows.
  const backup = new Client({ connectionString: forNodePg(backupUrl) });
  await backup.connect();
  try {
    await backup.query("SET row_security = on");
    const { rows } = await backup.query<{ hostels: number; users: number }>(
      "SELECT (SELECT count(*)::int FROM hostels) AS hostels, (SELECT count(*)::int FROM users) AS users",
    );
    console.log(
      `hostel_backup can log in and read every hostel: ${rows[0].hostels} hostels, ${rows[0].users} users.`,
    );
    console.log("Now save BACKUP_DATABASE_URL as the GitHub secret of the same name (docs/deploy.md).");
  } finally {
    await backup.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

import { appendFileSync } from "node:fs";
import { Client } from "pg";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import {
  backupUrlFrom,
  forNodePg,
  githubEnvLine,
  lockBackupLogin,
  maskCommand,
  newBackupPassword,
  setBackupLogin,
} from "./backupRole";

// The nightly backup's own login (2026-11-13), run by .github/workflows/backup.yml:
//   npx tsx scripts/backup-login.ts open    before the dump
//   npx tsx scripts/backup-login.ts close   after it, whatever happened
// "open" gives hostel_backup a new random password, checks it can read every hostel,
// hides the password and the URL in the log, and hands BACKUP_DATABASE_URL to the later
// steps through $GITHUB_ENV. "close" takes the login away again. Needs
// MIGRATION_DATABASE_URL (the production environment's secret). Prints counts only.

async function admin(): Promise<Client> {
  const url = process.env.MIGRATION_DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`MIGRATION_DATABASE_URL ${problem}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function open(): Promise<void> {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) throw new Error("GITHUB_ENV is not set: this runs inside GitHub Actions");

  const password = newBackupPassword();
  const url = backupUrlFrom(process.env.MIGRATION_DATABASE_URL ?? "", password);
  // Before anything else can print them.
  console.log(maskCommand(password));
  console.log(maskCommand(url));

  const client = await admin();
  try {
    await setBackupLogin(client, password);
  } finally {
    await client.end();
  }

  // The same reads pg_dump --enable-row-security makes: every hostel's rows.
  const backup = new Client({ connectionString: forNodePg(url) });
  await backup.connect();
  try {
    await backup.query("SET row_security = on");
    const { rows } = await backup.query<{ hostels: number; users: number }>(
      "SELECT (SELECT count(*)::int FROM hostels) AS hostels, (SELECT count(*)::int FROM users) AS users",
    );
    console.log(`hostel_backup can log in and read every hostel: ${rows[0].hostels} hostels, ${rows[0].users} users.`);
  } finally {
    await backup.end();
  }

  appendFileSync(githubEnv, githubEnvLine(url));
}

async function close(): Promise<void> {
  const client = await admin();
  try {
    await lockBackupLogin(client);
    console.log("hostel_backup is locked again: no login, no password.");
  } finally {
    await client.end();
  }
}

const step = process.argv[2];
const run = step === "open" ? open : step === "close" ? close : null;
if (!run) {
  console.error("Usage: npx tsx scripts/backup-login.ts open|close");
  process.exitCode = 1;
} else {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

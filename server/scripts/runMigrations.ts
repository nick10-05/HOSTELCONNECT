import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
// Any fixed number. Two runs at once would queue on this lock instead of colliding.
const LOCK_ID = 727001;

export type MigrationOptions = {
  // Admin credential that owns the tables.
  migrationUrl: string;
  // The app's own login; only its password is used, by migration 001.
  appUrl: string;
  log?: (line: string) => void;
};

// Shared by `npm run migrate` and the test setup, which migrates a throwaway database.
export async function runMigrations({
  migrationUrl,
  appUrl,
  log = console.log,
}: MigrationOptions): Promise<void> {
  // The app role's password lives in DATABASE_URL (the app's own login), so migration
  // 001 can create the role without the password ever being written in a file.
  const parsedAppUrl = new URL(appUrl);
  // Supabase's pooler logs in as "role.projectref", so compare only the part before the dot.
  const appRole = decodeURIComponent(parsedAppUrl.username).split(".")[0];
  const appPassword = decodeURIComponent(parsedAppUrl.password);
  if (appRole !== "hostel_app" || !appPassword) {
    throw new Error("DATABASE_URL must log in as hostel_app and include a password");
  }

  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    // Released automatically when the connection closes.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(done.rows.map((r) => [r.name, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      // Normalise line endings so a Windows checkout and a Linux CI hash the same file.
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").replace(/\r\n/g, "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");

      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `${file} was changed after it was applied. Never edit an applied migration; add a new one.`,
          );
        }
        log(`skip     ${file}`);
        continue;
      }

      // One transaction per migration: it fully applies or leaves no trace.
      await client.query("BEGIN");
      try {
        // Third argument true = visible only inside this transaction.
        await client.query("SELECT set_config('hostelconnect.app_password', $1, true)", [
          appPassword,
        ]);
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      log(`applied  ${file}`);
    }
  } finally {
    await client.end();
  }
}

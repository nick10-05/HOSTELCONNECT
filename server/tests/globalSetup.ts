import { Client } from "pg";
import { runMigrations } from "../scripts/runMigrations";
import { loadDotEnv } from "../src/loadEnv";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Runs once before all test files: recreate the test database and apply every
// migration, so each run starts empty and also proves the migrations still apply.
export default async function setup(): Promise<void> {
  loadDotEnv();
  const { MIGRATION_DATABASE_URL, DATABASE_URL } = process.env;
  if (!MIGRATION_DATABASE_URL || !DATABASE_URL) {
    throw new Error("Tests need MIGRATION_DATABASE_URL and DATABASE_URL (see .env.example)");
  }

  const testAdminUrl = toTestDatabaseUrl(MIGRATION_DATABASE_URL);
  const name = new URL(testAdminUrl).pathname.slice(1);
  // Second guard right before the DROP: never anything but a *_test database.
  if (!name.endsWith("_test")) throw new Error(`Refusing to recreate "${name}"`);

  // CREATE and DROP DATABASE cannot run while connected to that database.
  const maintenanceUrl = new URL(MIGRATION_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: maintenanceUrl.toString() });
  await admin.connect();
  try {
    // The name passed the [a-z0-9_] check in toTestDatabaseUrl, so quoting is safe.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  await runMigrations({
    migrationUrl: testAdminUrl,
    appUrl: toTestDatabaseUrl(DATABASE_URL),
    log: () => {},
  });
}

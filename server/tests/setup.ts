import { loadDotEnv } from "../src/loadEnv";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Loads the repo-root .env locally (in CI the workflow sets the variables), then
// points the app's connection at the test database that globalSetup prepared.
loadDotEnv();
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = toTestDatabaseUrl(process.env.DATABASE_URL);
}

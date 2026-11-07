import type { PoolClient } from "pg";
import type { Db } from "../../src/db";
import { savepointDb } from "../../src/lib/savepoints";

// A stand-in for the app's database pool that runs everything on ONE test connection,
// inside the test's own transaction, so a route test can call the real app and still
// leave nothing behind when it rolls back. Needed for anything that notifies every
// active student (announcements): committed, those notifications would reach the
// students other test files are checking at the same moment.
//
// The app's own transactions become savepoints (src/lib/savepoints.ts, which withHostel
// uses the same way). tests/rollbackDb.test.ts describes it.
export function rollbackDb(c: PoolClient): Db {
  return savepointDb(c, "test_tx");
}

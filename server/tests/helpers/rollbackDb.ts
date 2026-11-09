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
//
// A real transaction's hostel mark (withHostel, SET LOCAL) ends with it. A savepoint's
// does not end when it is released, so the mark the app's transaction set would outlive
// it here, and the test's next query would run in whichever hostel the app touched last
// (run-jobs goes through every hostel). So when one of the app's transactions ends, the
// test's own mark is put back.
export function rollbackDb(c: PoolClient): Db {
  const marks: string[] = [];
  const query = async (text: unknown, ...rest: unknown[]) => {
    if (typeof text === "string" && text.startsWith("SAVEPOINT test_tx_")) {
      const { rows } = await c.query<{ mark: string | null }>("SELECT current_setting('app.hostel_id', true) AS mark");
      marks.push(rows[0].mark ?? "");
      return c.query(text);
    }
    if (typeof text === "string" && text.startsWith("RELEASE SAVEPOINT test_tx_")) {
      const result = await c.query(text);
      await c.query("SELECT set_config('app.hostel_id', $1, true)", [marks.pop() ?? ""]);
      return result;
    }
    return (c.query as (...args: unknown[]) => Promise<unknown>)(text, ...rest);
  };
  return savepointDb({ query } as unknown as PoolClient, "test_tx");
}

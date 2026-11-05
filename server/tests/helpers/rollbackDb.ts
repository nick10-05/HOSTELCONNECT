import type { PoolClient } from "pg";
import type { Db } from "../../src/db";

// A stand-in for the app's database pool that runs everything on ONE test connection,
// inside the test's own transaction, so a route test can call the real app and still
// leave nothing behind when it rolls back. Needed for anything that notifies every
// active student (announcements): committed, those notifications would reach the
// students other test files are checking at the same moment.
//
// The app's own transactions become savepoints: BEGIN -> SAVEPOINT, COMMIT -> RELEASE,
// ROLLBACK -> ROLLBACK TO the savepoint (then RELEASE). release() does nothing; the test
// owns the connection. Queries run one at a time on that connection, as pg queues them.
// tests/rollbackDb.test.ts describes it.
export function rollbackDb(c: PoolClient): Db {
  const savepoints: string[] = [];
  let next = 0;

  // The app sends exactly these three words for its transactions (see services/*.ts).
  const translate = (text: unknown): string[] | null => {
    if (typeof text !== "string") return null;
    switch (text.trim().toUpperCase()) {
      case "BEGIN": {
        const name = `app_tx_${(next += 1)}`;
        savepoints.push(name);
        return [`SAVEPOINT ${name}`];
      }
      case "COMMIT":
        return [`RELEASE SAVEPOINT ${savepoints.pop()}`];
      case "ROLLBACK": {
        const name = savepoints.pop();
        return [`ROLLBACK TO SAVEPOINT ${name}`, `RELEASE SAVEPOINT ${name}`];
      }
      default:
        return null;
    }
  };

  const query = async (text: unknown, ...rest: unknown[]) => {
    const statements = translate(text);
    if (!statements) return (c.query as (...args: unknown[]) => Promise<unknown>)(text, ...rest);
    let result: unknown;
    for (const sql of statements) result = await c.query(sql);
    return result;
  };

  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as Db;
}

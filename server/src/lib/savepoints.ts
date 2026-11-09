import type { PoolClient } from "pg";
import type { Db } from "../db";

// A stand-in for the database pool that runs everything on ONE connection that is already
// inside a transaction. Services that open their own transaction (db.connect(), then
// BEGIN ... COMMIT or ROLLBACK, then release()) can then run unchanged inside a bigger one:
//
//   BEGIN    -> SAVEPOINT <name>
//   COMMIT   -> RELEASE SAVEPOINT <name>
//   ROLLBACK -> ROLLBACK TO SAVEPOINT <name>, then RELEASE SAVEPOINT <name>
//
// so a service's rollback still undoes exactly its own part, and the outer transaction
// stays usable after it. connect() hands out the same connection; release() does nothing,
// because the outer transaction owns it. Queries run one at a time on that connection,
// as pg queues them.
//
// Used by withHostel (src/db.ts), where the outer transaction is the request's, marked with
// its hostel, and by the tests' rollbackDb, where it is the test's own. Tests:
// tests/rollbackDb.test.ts and tests/withHostel.test.ts.
export function savepointDb(c: Pick<PoolClient, "query">, prefix = "app_tx"): Db {
  const savepoints: string[] = [];
  let next = 0;
  // The app sends exactly these three words for its transactions (see services/*.ts).
  const translate = (text: unknown): string[] | null => {
    if (typeof text !== "string") return null;
    switch (text.trim().toUpperCase()) {
      case "BEGIN": {
        const name = `${prefix}_${(next += 1)}`;
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

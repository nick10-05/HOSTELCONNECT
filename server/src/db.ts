import { Pool, types, type PoolClient } from "pg";

export type Db = Pool;
// What a service function needs: the pool, or one client inside a transaction.
export type Queryable = Pick<PoolClient, "query">;

// pg returns bigint (ids, count(*), sums) as strings because they can exceed
// JavaScript's safe integer range. Ours never get near 2^53, so parse them as numbers.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
// A DATE column (joining_date, started_on) is a calendar day with no time or zone. pg
// would turn it into a JavaScript Date at local midnight, which shifts the day when the
// server and the hostel are in different time zones. Keep it as the text 'YYYY-MM-DD'.
types.setTypeParser(types.builtins.DATE, (value) => value);

// One pool for the whole process, passed into createApp so tests can hand in their own.
// Kept small: Supabase's free pooler allows only a limited number of connections.
export function createPool(connectionString: string): Db {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    // Fail a request after 5 s instead of hanging while the database is unreachable.
    connectionTimeoutMillis: 5_000,
  });
  // The server or pooler may drop an idle connection. pg reports that here, and
  // without a listener Node would treat it as unhandled and crash the process.
  pool.on("error", (err) => {
    console.error("idle database connection error:", err.message);
  });
  return pool;
}

// Runs one request's work in one transaction marked with its hostel (multi-tenant phase
// 2a; tests/withHostel.test.ts). From phase 2d, row-level security shows a query only the
// rows of the hostel named here, so every query that touches a hostel's data runs inside.
//
// - The mark is set with set_config(..., true), which is SET LOCAL: it ends with the
//   transaction. Pooled connections are reused by other hostels' requests, so a mark that
//   outlived its transaction would hand one hostel's rows to the next.
// - Commits when fn succeeds; rolls back and passes the error on when it throws, so the
//   connection goes back to the pool clean either way.
// - The hostel id comes from the signed-in user's row (requireAuth), never from the
//   request; anything but a positive whole number is refused before connecting.
export async function withHostel<T>(db: Db, hostelId: number, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(hostelId) || hostelId < 1) {
    throw new Error(`withHostel: the hostel id must be a positive whole number, got ${hostelId}`);
  }
  const client = await db.connect();
  // Set when even ROLLBACK fails (a dropped connection): the pool then discards the
  // connection instead of handing it, in an unknown state, to the next request.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.hostel_id', $1, true)", [String(hostelId)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

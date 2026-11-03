import { Pool, types } from "pg";

export type Db = Pool;

// pg returns bigint (ids, count(*), sums) as strings because they can exceed
// JavaScript's safe integer range. Ours never get near 2^53, so parse them as numbers.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

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

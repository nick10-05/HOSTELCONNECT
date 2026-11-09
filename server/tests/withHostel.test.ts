import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { withHostel } from "../src/db";
import { testPool } from "./helpers/db";

// Multi-tenant phase 2a: withHostel(db, hostelId, fn) runs one request's work in one
// transaction marked with its hostel (the setting app.hostel_id), which row-level
// security reads from phase 2d on. The mark must never outlive the transaction, because
// pooled connections are reused by other hostels' requests.
const db = testPool();
afterAll(() => db.end());

const hostelSetting = "SELECT current_setting('app.hostel_id', true) AS hostel";

describe("withHostel", () => {
  it("marks the transaction with the hostel and returns what fn returns", async () => {
    const result = await withHostel(db, 7, async (c) => {
      const { rows } = await c.query<{ hostel: string }>(hostelSetting);
      return { hostel: rows[0].hostel };
    });
    expect(result).toEqual({ hostel: "7" });
  });

  it("runs fn inside one transaction", async () => {
    await withHostel(db, 1, async (c) => {
      const first = await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
      const second = await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
      expect(second.rows[0].xid).toBe(first.rows[0].xid);
    });
  });

  // A temporary table on a one-connection pool: it lives as long as that connection, so
  // the checks after withHostel see it, and no other test file sees these rows.
  it("commits when fn succeeds, and rolls back and passes the error on when fn throws", async () => {
    const single = testPoolOfOne();
    try {
      await single.query("CREATE TEMP TABLE marks (note text)");
      await withHostel(single, 1, async (c) => {
        await c.query("INSERT INTO marks VALUES ('kept')");
      });
      const boom = new Error("boom");
      await expect(
        withHostel(single, 1, async (c) => {
          await c.query("INSERT INTO marks VALUES ('undone')");
          throw boom;
        }),
      ).rejects.toBe(boom);
      const { rows } = await single.query("SELECT note FROM marks");
      expect(rows).toEqual([{ note: "kept" }]);
    } finally {
      await single.end();
    }
  });

  it("runs a service's own transaction as a savepoint: its rollback undoes only its part, and the hostel stays", async () => {
    const single = testPoolOfOne();
    try {
      await single.query("CREATE TEMP TABLE steps (note text)");
      await withHostel(single, 5, async (tx) => {
        await tx.query("INSERT INTO steps VALUES ('before')");
        // What a service does: its own connection, BEGIN, work, ROLLBACK on an error.
        const c = await tx.connect();
        await c.query("BEGIN");
        await c.query("INSERT INTO steps VALUES ('undone')");
        await expect(c.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
        await c.query("ROLLBACK");
        c.release();
        // A service that commits keeps its part.
        const d = await tx.connect();
        await d.query("BEGIN");
        await d.query("INSERT INTO steps VALUES ('kept')");
        const inside = await d.query<{ hostel: string }>(hostelSetting);
        expect(inside.rows[0].hostel).toBe("5");
        await d.query("COMMIT");
        d.release();
        await tx.query("INSERT INTO steps VALUES ('after')");
      });
      const { rows } = await single.query("SELECT note FROM steps");
      expect(rows.map((r) => r.note)).toEqual(["before", "kept", "after"]);
    } finally {
      await single.end();
    }
  });

  it("rolls back after a failed statement, so the connection goes back to the pool clean", async () => {
    await expect(
      withHostel(db, 1, async (c) => {
        await c.query("SELECT 1/0");
      }),
    ).rejects.toMatchObject({ code: "22012" });
    // A connection left inside a failed transaction would refuse every later query.
    const { rows } = await db.query<{ ok: number }>("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  it("leaves no hostel on the connection afterwards, even on the very same connection", async () => {
    // A pool of one connection, so the next query surely runs on the same one.
    const single = testPoolOfOne();
    try {
      await withHostel(single, 42, async () => undefined);
      const after = await single.query<{ hostel: string | null }>(hostelSetting);
      expect([null, ""]).toContain(after.rows[0].hostel);
      await expect(withHostel(single, 43, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
      const afterError = await single.query<{ hostel: string | null }>(hostelSetting);
      expect([null, ""]).toContain(afterError.rows[0].hostel);
    } finally {
      await single.end();
    }
  });

  it("gives the connection back to the pool, after success and after failure", async () => {
    const single = testPoolOfOne();
    try {
      await withHostel(single, 1, async () => undefined);
      await expect(withHostel(single, 1, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
      // With one connection, a leaked one would make this wait forever (connect timeout).
      await withHostel(single, 1, async () => undefined);
      expect(single.idleCount).toBe(1);
    } finally {
      await single.end();
    }
  });

  it("refuses a hostel id that is not a positive whole number, before touching the database", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      let ran = false;
      await expect(
        withHostel(db, bad, async () => {
          ran = true;
        }),
        String(bad),
      ).rejects.toThrow(/hostel id/i);
      expect(ran, String(bad)).toBe(false);
    }
  });
});

function testPoolOfOne() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Like createPool's pool, but with room for one connection only.
  return new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
}

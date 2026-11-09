import { afterAll, describe, expect, it } from "vitest";
import { withHostel } from "../src/db";
import { bareTestPool, inRollback, testPool } from "./helpers/db";

// Multi-tenant phase 2b (migration 015): current_hostel_id() is the hostel the current
// transaction works in, as withHostel marked it. Every query about a hostel's data
// filters on it (hostel_id = current_hostel_id()) and every insert names it, so the
// hostel comes from one place only. Outside withHostel it fails loudly instead of
// matching every hostel or none.
const db = testPool();
afterAll(() => db.end());

describe("current_hostel_id()", () => {
  it("is the hostel withHostel marked the transaction with", async () => {
    const id = await withHostel(db, 12, async (tx) => {
      const { rows } = await tx.query<{ id: number }>("SELECT current_hostel_id() AS id");
      return rows[0].id;
    });
    expect(id).toBe(12);
  });

  it("fails outside withHostel, so a query can never run for no hostel or all of them", async () => {
    const bare = bareTestPool();
    try {
      await expect(bare.query("SELECT current_hostel_id()")).rejects.toThrow(/no hostel/i);
      await withHostel(bare, 1, async () => undefined);
      await expect(bare.query("SELECT current_hostel_id()")).rejects.toThrow(/no hostel/i);
    } finally {
      await bare.end();
    }
  });

  // Migration 016: a new row belongs to the transaction's hostel, and outside withHostel
  // there is no hostel to give it.
  it("is the hostel of every new row, and an insert outside withHostel fails", async () => {
    await inRollback(db, async (c) => {
      const other = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Default Hostel') RETURNING id"))
        .rows[0].id;
      await c.query(`SET LOCAL app.hostel_id = '${other}'`);
      const { rows } = await c.query<{ hostel: number }>(
        "INSERT INTO buildings (name) VALUES ('Default Hostel Block') RETURNING hostel_id AS hostel",
      );
      expect(rows[0].hostel).toBe(other);
    });
    const bare = bareTestPool();
    try {
      await expect(bare.query("INSERT INTO buildings (name) VALUES ('Nowhere Block')")).rejects.toThrow(/no hostel/i);
    } finally {
      await bare.end();
    }
  });

  it("is hostel #1 on testPool's connections outside withHostel, and withHostel's mark wins", async () => {
    expect((await db.query("SELECT current_hostel_id() AS id")).rows[0].id).toBe(1);
    const inside = await withHostel(db, 4, async (tx) => (await tx.query("SELECT current_hostel_id() AS id")).rows[0].id);
    expect(inside).toBe(4);
    expect((await db.query("SELECT current_hostel_id() AS id")).rows[0].id).toBe(1);
  });

  it("may be called by the app and by nobody else, and is stable within a statement", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query(
        `SELECT has_function_privilege('public', 'current_hostel_id()', 'EXECUTE') AS public_can,
                has_function_privilege('hostel_app', 'current_hostel_id()', 'EXECUTE') AS app_can,
                provolatile FROM pg_proc WHERE proname = 'current_hostel_id'`,
      );
      expect(rows).toEqual([{ public_can: false, app_can: true, provolatile: "s" }]);
    }));
});

describe("test transactions", () => {
  it("run in hostel #1 unless a test names another", async () => {
    await inRollback(db, async (c) => {
      expect((await c.query("SELECT current_hostel_id() AS id")).rows[0].id).toBe(1);
    });
    await inRollback(
      db,
      async (c) => {
        expect((await c.query("SELECT current_hostel_id() AS id")).rows[0].id).toBe(3);
      },
      { hostelId: 3 },
    );
  });
});

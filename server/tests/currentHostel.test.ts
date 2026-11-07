import { afterAll, describe, expect, it } from "vitest";
import { withHostel } from "../src/db";
import { inRollback, testPool } from "./helpers/db";

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
    await expect(db.query("SELECT current_hostel_id()")).rejects.toThrow(/no hostel/i);
    await withHostel(db, 1, async () => undefined);
    await expect(db.query("SELECT current_hostel_id()")).rejects.toThrow(/no hostel/i);
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

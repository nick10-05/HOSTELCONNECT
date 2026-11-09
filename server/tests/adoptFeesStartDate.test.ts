import { afterAll, describe, expect, it } from "vitest";
import { adoptFeesStartDate } from "../src/services/hostels";
import { inRollback, testPool } from "./helpers/db";

// FEES_START_DATE, from before each hostel had its own date, becomes hostel #1's own date
// at startup (multi-tenant phase 5a), once.
const db = testPool();
afterAll(() => db.end());

const hostel1Date = async (c: { query: typeof db.query }) =>
  (await c.query<{ d: string | null }>("SELECT to_char(fees_start_date, 'YYYY-MM-DD') AS d FROM hostels WHERE id = 1")).rows[0].d;

describe("adoptFeesStartDate", () => {
  it("writes FEES_START_DATE to hostel #1 when it has no date yet", () =>
    inRollback(db, async (c) => {
      await c.query("UPDATE hostels SET fees_start_date = NULL WHERE id = 1");
      expect(await adoptFeesStartDate(c, "2026-12-01")).toBe(true);
      expect(await hostel1Date(c)).toBe("2026-12-01");
    }));

  it("leaves a date the hostel already has, so the owner's change wins", () =>
    inRollback(db, async (c) => {
      await c.query("UPDATE hostels SET fees_start_date = '2026-11-15' WHERE id = 1");
      expect(await adoptFeesStartDate(c, "2026-12-01")).toBe(false);
      expect(await hostel1Date(c)).toBe("2026-11-15");
    }));

  it("does nothing without the setting, and touches no other hostel", () =>
    inRollback(db, async (c) => {
      await c.query("UPDATE hostels SET fees_start_date = NULL WHERE id = 1");
      expect(await adoptFeesStartDate(c, undefined)).toBe(false);
      expect(await hostel1Date(c)).toBeNull();
      const other = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Other') RETURNING id")).rows[0].id;
      await adoptFeesStartDate(c, "2026-12-01");
      const { rows } = await c.query("SELECT fees_start_date FROM hostels WHERE id = $1", [other]);
      expect(rows[0].fees_start_date).toBeNull();
    }));
});

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDueFeeRows, FEE_ROW_DAYS_AHEAD } from "../src/jobs/feeRows";
import { nthDueDate } from "../src/services/fees";
import { inRollback, insertOwner, testPool } from "./helpers/db";

// The fee-rows job (day 9, Claude at Nikhil's request; section 12 lists "fee row creation
// by joining date" under "You write"). The job works on every active student, so every
// test runs in a transaction that is rolled back, and uses dates in 1997 and 1998: other
// files' students joined years later, so they have no due dates then, and every count here
// is exact. (Another file's uncommitted rows for the same student cannot exist: these
// students are this test's own.)
const db = testPool();
afterAll(() => db.end());

type Opts = { fee?: number | null; active?: boolean };

// A student who joined on `joined`, with a monthly fee (6500 unless given).
async function student(c: PoolClient, joined: string, opts: Opts = {}): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference, monthly_fee)
     VALUES ('student', 'Fee Student', $1, 'not-a-real-hash', false, $2,
             '9000000000', '9000000001', 'other', $3, 'veg', $4) RETURNING id`,
    [`fees-${randomUUID()}@test.local`, opts.active ?? true, joined, opts.fee === undefined ? 6500 : opts.fee],
  );
  return rows[0].id;
}

type Row = { dueDate: string; amount: number | null; status: string; paidOn: string | null };

const rowsOf = async (c: PoolClient, studentId: number): Promise<Row[]> =>
  (
    await c.query<Row>(
      `SELECT due_date AS "dueDate", amount, status, paid_on AS "paidOn"
       FROM fees WHERE student_id = $1 ORDER BY due_date`,
      [studentId],
    )
  ).rows;
const datesOf = async (c: PoolClient, studentId: number) => (await rowsOf(c, studentId)).map((r) => r.dueDate);

const START = "1997-01-01";

describe("createDueFeeRows", () => {
  it("creates a pending row for each due date from the start date to 7 days ahead, with the fee", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-01-14");

      const result = await createDueFeeRows(c, { today: "1998-04-10", startDate: START });

      // 14 April is within 7 days of 10 April; 14 May is not.
      expect(await rowsOf(c, s)).toEqual([
        { dueDate: "1998-02-14", amount: 6500, status: "pending", paidOn: null },
        { dueDate: "1998-03-14", amount: 6500, status: "pending", paidOn: null },
        { dueDate: "1998-04-14", amount: 6500, status: "pending", paidOn: null },
      ]);
      expect(result).toEqual({ created: 3 });
    }));

  it("includes a due date exactly 7 days ahead and not one 8 days ahead", () =>
    inRollback(db, async (c) => {
      expect(FEE_ROW_DAYS_AHEAD).toBe(7);
      const s = await student(c, "1998-01-17");
      await createDueFeeRows(c, { today: "1998-02-10", startDate: START });
      expect(await datesOf(c, s)).toEqual(["1998-02-17"]);

      const t = await student(c, "1998-01-18");
      await createDueFeeRows(c, { today: "1998-02-10", startDate: START });
      expect(await datesOf(c, t)).toEqual([]);
    }));

  it("counts each date from the joining date, clamped to the month's end, as nthDueDate does", () =>
    inRollback(db, async (c) => {
      const jan31 = await student(c, "1997-01-31");
      const leap = await student(c, "1996-01-31"); // 1996 is a leap year: no rows before START
      const aug31 = await student(c, "1997-08-31");

      await createDueFeeRows(c, { today: "1998-03-25", startDate: START });

      const expected = (joined: string, n: number) =>
        Array.from({ length: n }, (_, i) => nthDueDate(joined, i + 1)).filter((d) => d >= START && d <= "1998-04-01");
      expect(await datesOf(c, jan31)).toEqual(expected("1997-01-31", 16));
      expect((await datesOf(c, jan31)).slice(0, 4)).toEqual(["1997-02-28", "1997-03-31", "1997-04-30", "1997-05-31"]);
      expect(await datesOf(c, leap)).toEqual(expected("1996-01-31", 28));
      expect(await datesOf(c, aug31)).toEqual(["1997-09-30", "1997-10-31", "1997-11-30", "1997-12-31", "1998-01-31", "1998-02-28", "1998-03-31"]);
    }));

  it("uses 29 February in a leap year", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1996-01-30");
      await createDueFeeRows(c, { today: "1996-02-25", startDate: "1996-01-01" });
      expect(await datesOf(c, s)).toEqual(["1996-02-29"]);
    }));

  it("creates no row before the start date, however long ago the student joined", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1995-06-14");
      await createDueFeeRows(c, { today: "1998-04-10", startDate: "1998-03-15" });
      expect(await datesOf(c, s)).toEqual(["1998-04-14"]);
    }));

  it("never makes the joining date itself a due date, and nothing before the first month", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-04-12");
      const result = await createDueFeeRows(c, { today: "1998-04-12", startDate: START });
      expect(await datesOf(c, s)).toEqual([]);
      expect(result).toEqual({ created: 0 });
    }));

  it("creates nothing for a student whose joining date is still ahead", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-05-01");
      await createDueFeeRows(c, { today: "1998-04-10", startDate: START });
      expect(await datesOf(c, s)).toEqual([]);
    }));

  it("copies the fee as it is now, and NULL when none is set", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-03-14", { fee: 7200 });
      const none = await student(c, "1998-03-14", { fee: null });
      const zero = await student(c, "1998-03-14", { fee: 0 });
      await createDueFeeRows(c, { today: "1998-04-10", startDate: START });
      expect((await rowsOf(c, s)).map((r) => r.amount)).toEqual([7200]);
      expect((await rowsOf(c, none)).map((r) => r.amount)).toEqual([null]);
      expect((await rowsOf(c, zero)).map((r) => r.amount)).toEqual([0]);
    }));

  it("creates nothing for students who are not active, and never for the owner", () =>
    inRollback(db, async (c) => {
      const left = await student(c, "1998-01-14", { active: false });
      const owner = await insertOwner(c);
      await c.query(`UPDATE users SET joining_date = '1998-01-14' WHERE id = $1`, [owner]);
      const result = await createDueFeeRows(c, { today: "1998-04-10", startDate: START });
      expect(await datesOf(c, left)).toEqual([]);
      expect(await datesOf(c, owner)).toEqual([]);
      expect(result).toEqual({ created: 0 });
    }));

  it("leaves existing rows as they are and creates nothing twice", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-01-14");
      const owner = await insertOwner(c);
      await createDueFeeRows(c, { today: "1998-02-10", startDate: START }); // 14 February
      await c.query(
        `UPDATE fees SET status = 'paid', paid_on = '1998-02-15', recorded_by = $2 WHERE student_id = $1 AND due_date = '1998-02-14'`,
        [s, owner],
      );
      await c.query(`UPDATE users SET monthly_fee = 9000 WHERE id = $1`, [s]);

      expect(await createDueFeeRows(c, { today: "1998-03-10", startDate: START })).toEqual({ created: 1 }); // 14 March
      expect(await createDueFeeRows(c, { today: "1998-03-10", startDate: START })).toEqual({ created: 0 });
      expect(await rowsOf(c, s)).toEqual([
        { dueDate: "1998-02-14", amount: 6500, status: "paid", paidOn: "1998-02-15" },
        { dueDate: "1998-03-14", amount: 9000, status: "pending", paidOn: null },
      ]);
    }));

  it("follows a new joining date after a rejoin, keeping the old rows", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "1998-01-14");
      await createDueFeeRows(c, { today: "1998-02-10", startDate: START });
      expect(await datesOf(c, s)).toEqual(["1998-02-14"]);

      await c.query(`UPDATE users SET joining_date = '1998-03-20' WHERE id = $1`, [s]);
      await createDueFeeRows(c, { today: "1998-04-15", startDate: START });

      // 14 March and 14 April belong to the old cycle and are not created.
      expect(await datesOf(c, s)).toEqual(["1998-02-14", "1998-04-20"]);
    }));

  it("counts every row it created, across students", () =>
    inRollback(db, async (c) => {
      await student(c, "1998-01-14");
      await student(c, "1998-02-14");
      const before = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM fees`)).rows[0].n;
      const result = await createDueFeeRows(c, { today: "1998-04-10", startDate: START });
      const after = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM fees`)).rows[0].n;
      expect(result).toEqual({ created: 3 + 2 });
      expect(after - before).toBe(5);
    }));
});

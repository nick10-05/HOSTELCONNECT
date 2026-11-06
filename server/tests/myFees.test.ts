import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getMyFees } from "../src/services/fees";
import { inRollback, insertOwner, testPool } from "./helpers/db";

// A student's own fees (day 9, Claude at Nikhil's request; section 12 lists "balance
// calculation" under "You write"). Rows are written straight to the fees table, so these
// tests do not depend on the fee-rows job. Each test rolls back.
const db = testPool();
afterAll(() => db.end());

const TODAY = "2026-04-14";

async function student(c: PoolClient, joined = "2026-01-14"): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference, monthly_fee)
     VALUES ('student', 'Fee Student', $1, 'not-a-real-hash', false, true,
             '9000000000', '9000000001', 'other', $2, 'veg', 6500) RETURNING id`,
    [`myfees-${randomUUID()}@test.local`, joined],
  );
  return rows[0].id;
}

type Fee = { due: string; amount?: number | null; paidOn?: string; note?: string };

// A fee row: pending, or paid when `paidOn` is given. Returns its id.
async function fee(c: PoolClient, studentId: number, f: Fee): Promise<number> {
  const owner = f.paidOn ? await insertOwner(c) : null;
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO fees (student_id, due_date, amount, status, paid_on, recorded_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      studentId,
      f.due,
      f.amount === undefined ? 6500 : f.amount,
      f.paidOn ? "paid" : "pending",
      f.paidOn ?? null,
      owner,
      f.paidOn ? (f.note ?? null) : null,
    ],
  );
  return rows[0].id;
}

describe("getMyFees", () => {
  it("adds up pending rows due today or earlier, and leaves out paid and later ones", () =>
    inRollback(db, async (c) => {
      const s = await student(c);
      await fee(c, s, { due: "2026-02-14", paidOn: "2026-02-15" });
      await fee(c, s, { due: "2026-03-14", amount: 6500 });
      await fee(c, s, { due: "2026-04-14", amount: 7000 }); // due today: counts
      await fee(c, s, { due: "2026-04-20", amount: 7000 }); // later: does not

      const mine = await getMyFees(c, s, TODAY);
      expect(mine.pendingBalance).toBe(13_500);
      expect(mine.amountNotSet).toBe(0);
    }));

  it("adds nothing for a row with no amount, and says how many there are", () =>
    inRollback(db, async (c) => {
      const s = await student(c);
      await fee(c, s, { due: "2026-02-14", amount: null });
      await fee(c, s, { due: "2026-03-14", amount: 6500 });
      await fee(c, s, { due: "2026-04-20", amount: null }); // later: not counted either way
      await fee(c, s, { due: "2026-01-14", amount: null, paidOn: "2026-01-20" }); // paid: not counted

      const mine = await getMyFees(c, s, TODAY);
      expect(mine.pendingBalance).toBe(6500);
      expect(mine.amountNotSet).toBe(1);
    }));

  it("lists overdue (oldest first) and upcoming (soonest first), and today's row in neither", () =>
    inRollback(db, async (c) => {
      const s = await student(c);
      const march = await fee(c, s, { due: "2026-03-14" });
      const feb = await fee(c, s, { due: "2026-02-14" });
      const today = await fee(c, s, { due: "2026-04-14" });
      const later = await fee(c, s, { due: "2026-05-14" });
      const soon = await fee(c, s, { due: "2026-04-18" });
      await fee(c, s, { due: "2026-01-14", paidOn: "2026-01-14" });

      const mine = await getMyFees(c, s, TODAY);
      expect(mine.overdue.map((r) => r.id)).toEqual([feb, march]);
      expect(mine.upcoming.map((r) => r.id)).toEqual([soon, later]);
      expect([...mine.overdue, ...mine.upcoming].map((r) => r.id)).not.toContain(today);
    }));

  it("gives the whole history, newest due date first, with every field", () =>
    inRollback(db, async (c) => {
      const s = await student(c);
      const jan = await fee(c, s, { due: "2026-02-14", paidOn: "2026-02-16", note: "paid by UPI" });
      const feb = await fee(c, s, { due: "2026-03-14", amount: null });
      const mar = await fee(c, s, { due: "2026-04-14" });

      const mine = await getMyFees(c, s, TODAY);
      expect(mine.history).toEqual([
        { id: mar, dueDate: "2026-04-14", amount: 6500, status: "pending", paidOn: null, note: null },
        { id: feb, dueDate: "2026-03-14", amount: null, status: "pending", paidOn: null, note: null },
        { id: jan, dueDate: "2026-02-14", amount: 6500, status: "paid", paidOn: "2026-02-16", note: "paid by UPI" },
      ]);
      expect(Object.keys(mine).sort()).toEqual(
        ["amountNotSet", "history", "nextDueDate", "overdue", "pendingBalance", "upcoming"].sort(),
      );
    }));

  it("shows only the student's own rows", () =>
    inRollback(db, async (c) => {
      const me = await student(c);
      const other = await student(c);
      await fee(c, other, { due: "2026-03-14" });
      await fee(c, other, { due: "2026-04-20" });
      const mine = await getMyFees(c, me, TODAY);
      expect(mine).toEqual({
        pendingBalance: 0,
        amountNotSet: 0,
        overdue: [],
        upcoming: [],
        history: [],
        nextDueDate: "2026-04-14",
      });
    }));

  it("gives the next due date from the joining date: today when it is a due date, else the next", () =>
    inRollback(db, async (c) => {
      const s = await student(c, "2026-01-31");
      expect((await getMyFees(c, s, "2026-02-28")).nextDueDate).toBe("2026-02-28");
      expect((await getMyFees(c, s, "2026-03-01")).nextDueDate).toBe("2026-03-31");
      expect((await getMyFees(c, s, "2026-01-31")).nextDueDate).toBe("2026-02-28");
    }));
});

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { FEE_REMINDER_LINK, reminderStage, sendFeeReminders } from "../src/jobs/feeReminders";
import { addDays } from "../src/lib/dates";
import { inRollback, insertOwner, testPool } from "./helpers/db";

// The fee-reminders job (day 10, Claude at Nikhil's request; section 12 lists "reminder
// timing" under "You write"). The job works on every pending fee, so every test runs in a
// transaction that is rolled back, and uses due dates in 1998: no other file has fee rows
// then, so every count here is exact.
const db = testPool();
afterAll(() => db.end());

const DUE = "1998-04-14";

describe("reminderStage", () => {
  // Days after the due date (negative: before it) and the stage that day gets.
  const table: [number, ReturnType<typeof reminderStage>][] = [
    [-30, null],
    [-7, null],
    [-4, null],
    [-3, "before"],
    [-2, "before"],
    [-1, "before"],
    [0, "due"],
    [1, "due"],
    [2, "due"],
    [3, "overdue"],
    [6, "overdue"],
    [9, "overdue"],
    [10, null],
    [60, null],
  ];
  it.each(table)("%i days from the due date gives %s", (days, stage) => {
    expect(reminderStage(DUE, addDays(DUE, days))).toBe(stage);
  });

  it("counts across a month's end and a year's end", () => {
    expect(reminderStage("1998-03-02", "1998-02-27")).toBe("before");
    expect(reminderStage("1998-03-02", "1998-02-26")).toBe(null);
    expect(reminderStage("1998-12-30", "1999-01-02")).toBe("overdue");
    expect(reminderStage("1998-12-30", "1999-01-08")).toBe("overdue");
    expect(reminderStage("1998-12-30", "1999-01-09")).toBe(null);
  });
});

// A student with a fee row due on `due` (pending unless paid), with `amount` (6500 unless given).
async function studentWithFee(
  c: PoolClient,
  due: string,
  opts: { amount?: number | null; active?: boolean; paidBy?: number } = {},
): Promise<{ student: number; fee: number }> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference, monthly_fee)
     VALUES ('student', 'Reminder Student', $1, 'not-a-real-hash', false, $2,
             '9000000000', '9000000001', 'other', '1998-01-14', 'veg', 6500) RETURNING id`,
    [`reminders-${randomUUID()}@test.local`, opts.active ?? true],
  );
  const student = rows[0].id;
  const fee = await addFee(c, student, due, opts);
  return { student, fee };
}

async function addFee(
  c: PoolClient,
  student: number,
  due: string,
  opts: { amount?: number | null; paidBy?: number } = {},
): Promise<number> {
  const paid = opts.paidBy !== undefined;
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO fees (student_id, due_date, amount, status, paid_on, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [student, due, opts.amount === undefined ? 6500 : opts.amount, paid ? "paid" : "pending", paid ? due : null, opts.paidBy ?? null],
  );
  return rows[0].id;
}

type Sent = { type: string; title: string; body: string | null; link: string | null; dedupKey: string | null };

const sentTo = async (c: PoolClient, student: number): Promise<Sent[]> =>
  (
    await c.query<Sent>(
      `SELECT type, title, body, link, dedup_key AS "dedupKey"
       FROM notifications WHERE user_id = $1 ORDER BY id`,
      [student],
    )
  ).rows;
const titlesTo = async (c: PoolClient, student: number) => (await sentTo(c, student)).map((n) => n.title);

describe("sendFeeReminders", () => {
  it("reminds 3 days before the due date, once, with the amount and a link to My fees", () =>
    inRollback(db, async (c) => {
      const { student, fee } = await studentWithFee(c, DUE);

      expect(await sendFeeReminders(c, { today: "1998-04-11" })).toEqual({ created: 1 });

      expect(await sentTo(c, student)).toEqual([
        {
          type: "fee_reminder",
          title: "Fee due in 3 days",
          body: "₹6,500 is due on 14 Apr 1998.",
          link: FEE_REMINDER_LINK,
          dedupKey: `fee:${fee}:before`,
        },
      ]);
      expect(FEE_REMINDER_LINK).toBe("/fees");
    }));

  it("sends nothing more on later runs the same day, or in the rest of the window", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE);
      await sendFeeReminders(c, { today: "1998-04-11" });

      expect(await sendFeeReminders(c, { today: "1998-04-11" })).toEqual({ created: 0 });
      expect(await sendFeeReminders(c, { today: "1998-04-12" })).toEqual({ created: 0 });
      expect(await sendFeeReminders(c, { today: "1998-04-13" })).toEqual({ created: 0 });
      expect(await titlesTo(c, student)).toEqual(["Fee due in 3 days"]);
    }));

  it("sends all three over a fee's life when it stays pending, and nothing after", () =>
    inRollback(db, async (c) => {
      const { student, fee } = await studentWithFee(c, DUE);

      for (let day = -10; day <= 70; day += 1) {
        await sendFeeReminders(c, { today: addDays(DUE, day) });
      }

      const sent = await sentTo(c, student);
      expect(sent.map((n) => [n.title, n.body, n.dedupKey])).toEqual([
        ["Fee due in 3 days", "₹6,500 is due on 14 Apr 1998.", `fee:${fee}:before`],
        ["Fee due today", "₹6,500 is due today.", `fee:${fee}:due`],
        ["Fee overdue", "₹6,500 was due on 14 Apr 1998 and is still pending.", `fee:${fee}:overdue`],
      ]);
    }));

  it("still reminds when the run comes late, saying how many days are left", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE);

      await sendFeeReminders(c, { today: "1998-04-13" }); // first run: 1 day left
      await sendFeeReminders(c, { today: "1998-04-16" }); // no run on the 14th or 15th
      await sendFeeReminders(c, { today: "1998-04-23" }); // nothing until the overdue window's last day

      expect(await titlesTo(c, student)).toEqual(["Fee due in 1 day", "Fee due today", "Fee overdue"]);
    }));

  it("says 2 days when two are left", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE);
      await sendFeeReminders(c, { today: "1998-04-12" });
      expect(await titlesTo(c, student)).toEqual(["Fee due in 2 days"]);
    }));

  it("sends only today's reminder, never an earlier one it missed", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE);
      expect(await sendFeeReminders(c, { today: "1998-04-18" })).toEqual({ created: 1 });
      expect(await titlesTo(c, student)).toEqual(["Fee overdue"]);
    }));

  it("sends nothing outside the windows", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE);
      expect(await sendFeeReminders(c, { today: "1998-04-10" })).toEqual({ created: 0 });
      expect(await sendFeeReminders(c, { today: "1998-04-24" })).toEqual({ created: 0 });
      expect(await sentTo(c, student)).toEqual([]);
    }));

  it("sends nothing for a paid fee, on any day", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const { student } = await studentWithFee(c, DUE, { paidBy: owner });
      for (const day of [-3, 0, 3]) {
        expect(await sendFeeReminders(c, { today: addDays(DUE, day) })).toEqual({ created: 0 });
      }
      expect(await sentTo(c, student)).toEqual([]);
    }));

  it("stops once the fee is marked paid", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const { student, fee } = await studentWithFee(c, DUE);
      await sendFeeReminders(c, { today: DUE });
      await c.query(`UPDATE fees SET status = 'paid', paid_on = $2, recorded_by = $3 WHERE id = $1`, [fee, DUE, owner]);
      await sendFeeReminders(c, { today: addDays(DUE, 3) });
      expect(await titlesTo(c, student)).toEqual(["Fee due today"]);
    }));

  it("sends nothing to a student who has moved out", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE, { active: false });
      expect(await sendFeeReminders(c, { today: DUE })).toEqual({ created: 0 });
      expect(await sentTo(c, student)).toEqual([]);
    }));

  it('says "Your fee" when no amount is set, and sends nothing for a fee of ₹0', () =>
    inRollback(db, async (c) => {
      const none = await studentWithFee(c, DUE, { amount: null });
      const zero = await studentWithFee(c, DUE, { amount: 0 });

      await sendFeeReminders(c, { today: "1998-04-11" });
      await sendFeeReminders(c, { today: DUE });
      await sendFeeReminders(c, { today: "1998-04-17" });

      expect((await sentTo(c, none.student)).map((n) => n.body)).toEqual([
        "Your fee is due on 14 Apr 1998.",
        "Your fee is due today.",
        "Your fee was due on 14 Apr 1998 and is still pending.",
      ]);
      expect(await sentTo(c, zero.student)).toEqual([]);
    }));

  it("writes large amounts in Indian grouping", () =>
    inRollback(db, async (c) => {
      const { student } = await studentWithFee(c, DUE, { amount: 125000 });
      await sendFeeReminders(c, { today: DUE });
      expect((await sentTo(c, student)).map((n) => n.body)).toEqual(["₹1,25,000 is due today."]);
    }));

  it("reminds about each pending fee separately", () =>
    inRollback(db, async (c) => {
      const { student, fee: march } = await studentWithFee(c, "1998-03-14");
      const april = await addFee(c, student, DUE);

      // 17 April: 14 March is past every window; 14 April is 3 days overdue.
      // 12 March would be 2 days before 14 March, and 14 April is not yet in a window.
      expect(await sendFeeReminders(c, { today: "1998-03-12" })).toEqual({ created: 1 });
      expect(await sendFeeReminders(c, { today: "1998-04-17" })).toEqual({ created: 1 });

      expect((await sentTo(c, student)).map((n) => n.dedupKey)).toEqual([
        `fee:${march}:before`,
        `fee:${april}:overdue`,
      ]);
    }));

  it("reminds every student whose fee is in a window, in one run", () =>
    inRollback(db, async (c) => {
      const a = await studentWithFee(c, "1998-04-14");
      const b = await studentWithFee(c, "1998-04-11");
      const d = await studentWithFee(c, "1998-04-08");
      const e = await studentWithFee(c, "1998-04-01"); // 10 days overdue: no reminder

      expect(await sendFeeReminders(c, { today: "1998-04-11" })).toEqual({ created: 3 });
      expect(await titlesTo(c, a.student)).toEqual(["Fee due in 3 days"]);
      expect(await titlesTo(c, b.student)).toEqual(["Fee due today"]);
      expect(await titlesTo(c, d.student)).toEqual(["Fee overdue"]);
      expect(await titlesTo(c, e.student)).toEqual([]);
    }));
});

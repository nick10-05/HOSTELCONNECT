import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { listFees, markFeeInTransaction, PAYMENT_LINK, type FeeFilters } from "../src/services/fees";
import { inRollback, insertOwner, testPool } from "./helpers/db";

// The owner's fee list and marking a fee paid or pending (day 9, Claude). Each test rolls
// back. Fee rows are dated July 1997: no other test file has fee rows then (the others roll
// back too, and use other years), so the month's totals here are exact.
const db = testPool();
afterAll(() => db.end());

const TODAY = "1997-07-15";
const MONTH = "1997-07";
const ALL: FeeFilters = { month: MONTH, status: null, buildingId: null, page: 1, limit: 50 };

async function newBuilding(c: PoolClient): Promise<{ id: number; name: string }> {
  const name = `Fees ${randomUUID()}`;
  const { rows } = await c.query<{ id: number }>("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]);
  return { id: rows[0].id, name };
}

// A student called `name`, living in `building` now (or moved out when `active` is false).
async function student(c: PoolClient, name: string, building: number, active = true): Promise<number> {
  const owner = await insertOwner(c);
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference, monthly_fee)
     VALUES ('student', $1, $2, 'not-a-real-hash', false, $3,
             '9000000000', '9000000001', 'other', '1997-01-01', 'veg', 6500) RETURNING id`,
    [name, `ownerfees-${randomUUID()}@test.local`, active],
  );
  await c.query(
    `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by) VALUES ($1, $2, '1997-01-01', $3, $4)`,
    [rows[0].id, building, active ? null : "1997-07-05", owner],
  );
  return rows[0].id;
}

type Fee = { due: string; amount?: number | null; paidOn?: string; note?: string };

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

const ids = (items: { id: number }[]) => items.map((r) => r.id);

async function refusal(call: Promise<unknown>) {
  const err = await call.then(
    () => {
      throw new Error("expected a refusal, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const { status, code, message } = err as HttpError;
  return { status, code, message };
}

const rowOf = async (c: PoolClient, id: number) =>
  (
    await c.query(
      `SELECT status, paid_on AS "paidOn", recorded_by AS "recordedBy", note FROM fees WHERE id = $1`,
      [id],
    )
  ).rows[0];

const bellOf = async (c: PoolClient, userId: number) =>
  (await c.query(`SELECT type, title, body, link, dedup_key AS "dedupKey" FROM notifications WHERE user_id = $1 ORDER BY id`, [userId]))
    .rows;

describe("listFees", () => {
  it("lists the month's rows with each one's state today, and every field", () =>
    inRollback(db, async (c) => {
      const b = await newBuilding(c);
      const s = await student(c, "Asha", b.id);
      const overdue = await fee(c, s, { due: "1997-07-01" });
      const paid = await fee(c, s, { due: "1997-07-10", paidOn: "1997-07-11", note: "paid by UPI" });
      const due = await fee(c, s, { due: "1997-07-15", amount: null });
      const upcoming = await fee(c, s, { due: "1997-07-20" });
      await fee(c, s, { due: "1997-06-30" }); // June
      await fee(c, s, { due: "1997-08-01" }); // August

      const { items, total } = await listFees(c, ALL, TODAY);

      const base = { studentId: s, studentName: "Asha", isActive: true, buildingId: b.id, buildingName: b.name };
      expect(items).toEqual([
        { ...base, id: overdue, dueDate: "1997-07-01", amount: 6500, status: "pending", state: "overdue", paidOn: null, note: null },
        { ...base, id: paid, dueDate: "1997-07-10", amount: 6500, status: "paid", state: "paid", paidOn: "1997-07-11", note: "paid by UPI" },
        { ...base, id: due, dueDate: "1997-07-15", amount: null, status: "pending", state: "due", paidOn: null, note: null },
        { ...base, id: upcoming, dueDate: "1997-07-20", amount: 6500, status: "pending", state: "upcoming", paidOn: null, note: null },
      ]);
      expect(total).toBe(4);
    }));

  it("orders by due date, then name ignoring case, then id", () =>
    inRollback(db, async (c) => {
      const b = await newBuilding(c);
      const bob = await fee(c, await student(c, "bob", b.id), { due: "1997-07-03" });
      const alice1 = await fee(c, await student(c, "alice", b.id), { due: "1997-07-03" });
      const alice2 = await fee(c, await student(c, "Alice", b.id), { due: "1997-07-03" });
      const early = await fee(c, await student(c, "Zara", b.id), { due: "1997-07-02" });
      expect(ids((await listFees(c, ALL, TODAY)).items)).toEqual([early, alice1, alice2, bob]);
    }));

  it("filters by status: paid, pending, or overdue (pending and due before today)", () =>
    inRollback(db, async (c) => {
      const b = await newBuilding(c);
      const s = await student(c, "Asha", b.id);
      const overdue = await fee(c, s, { due: "1997-07-01" });
      const paid = await fee(c, s, { due: "1997-07-10", paidOn: "1997-07-11" });
      const due = await fee(c, s, { due: "1997-07-15" });
      const upcoming = await fee(c, s, { due: "1997-07-20" });

      const by = async (status: FeeFilters["status"]) => listFees(c, { ...ALL, status }, TODAY);
      expect(ids((await by("paid")).items)).toEqual([paid]);
      expect(ids((await by("pending")).items)).toEqual([overdue, due, upcoming]);
      expect(ids((await by("overdue")).items)).toEqual([overdue]);
      expect((await by("pending")).total).toBe(3);
    }));

  it("filters by the student's current building, and shows a moved-out student only without it", () =>
    inRollback(db, async (c) => {
      const [a, b] = [await newBuilding(c), await newBuilding(c)];
      const mover = await student(c, "Asha", b.id);
      const owner = await insertOwner(c);
      await c.query(
        `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by) VALUES ($1, $2, '1996-01-01', '1997-01-01', $3)`,
        [mover, a.id, owner],
      );
      const moved = await fee(c, mover, { due: "1997-07-03" });
      const leaver = await student(c, "Bilal", a.id, false);
      const left = await fee(c, leaver, { due: "1997-07-04" });

      expect(ids((await listFees(c, { ...ALL, buildingId: a.id }, TODAY)).items)).toEqual([]);
      expect(ids((await listFees(c, { ...ALL, buildingId: b.id }, TODAY)).items)).toEqual([moved]);
      const all = (await listFees(c, ALL, TODAY)).items;
      expect(all.find((r) => r.id === left)).toMatchObject({ isActive: false, buildingId: null, buildingName: null });
    }));

  it("totals the month, following the building filter but not the status filter", () =>
    inRollback(db, async (c) => {
      const [a, b] = [await newBuilding(c), await newBuilding(c)];
      const s = await student(c, "Asha", a.id);
      await fee(c, s, { due: "1997-07-01", amount: 5000 }); // overdue
      await fee(c, s, { due: "1997-07-02", amount: null }); // overdue, no amount
      await fee(c, s, { due: "1997-07-10", amount: 6000, paidOn: "1997-07-10" });
      await fee(c, s, { due: "1997-07-12", amount: null, paidOn: "1997-07-12" }); // paid, no amount: not in amountNotSet
      await fee(c, s, { due: "1997-07-20", amount: 7000 }); // upcoming
      await fee(c, await student(c, "Bilal", b.id), { due: "1997-07-05", amount: 1000, paidOn: "1997-07-05" });
      await fee(c, s, { due: "1997-06-01", amount: 99_999 }); // June: never counted

      const expected = {
        paid: { count: 2, amount: 6000 },
        pending: { count: 3, amount: 12_000 },
        overdue: { count: 2, amount: 5000 },
        amountNotSet: 1,
      };
      expect((await listFees(c, { ...ALL, buildingId: a.id }, TODAY)).totals).toEqual(expected);
      for (const status of ["paid", "pending", "overdue"] as const) {
        expect((await listFees(c, { ...ALL, buildingId: a.id, status }, TODAY)).totals, status).toEqual(expected);
      }
      expect((await listFees(c, ALL, TODAY)).totals).toEqual({ ...expected, paid: { count: 3, amount: 7000 } });
    }));

  it("gives zeros for a month with no rows", () =>
    inRollback(db, async (c) => {
      expect(await listFees(c, { ...ALL, month: "1997-02" }, TODAY)).toEqual({
        items: [],
        total: 0,
        totals: { paid: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, amountNotSet: 0 },
      });
    }));

  it("pages, with the total of every matching row", () =>
    inRollback(db, async (c) => {
      const b = await newBuilding(c);
      const s = await student(c, "Asha", b.id);
      const rows = [];
      for (const day of ["01", "02", "03", "04", "05"]) rows.push(await fee(c, s, { due: `1997-07-${day}` }));
      const page2 = await listFees(c, { ...ALL, page: 2, limit: 2 }, TODAY);
      expect(ids(page2.items)).toEqual(rows.slice(2, 4));
      expect(page2.total).toBe(5);
      expect((await listFees(c, { ...ALL, page: 4, limit: 2 }, TODAY)).items).toEqual([]);
    }));
});

describe("markFeeInTransaction", () => {
  it("marks a fee paid with the date and note, returns it, and notifies the student", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id);
      const id = await fee(c, s, { due: "1997-07-10" });

      const marked = await markFeeInTransaction(c, id, owner, { status: "paid", paidOn: "1997-07-12", note: "paid by UPI" }, TODAY);

      expect(marked).toEqual({
        id,
        studentId: s,
        dueDate: "1997-07-10",
        amount: 6500,
        status: "paid",
        paidOn: "1997-07-12",
        note: "paid by UPI",
      });
      expect(await rowOf(c, id)).toEqual({ status: "paid", paidOn: "1997-07-12", recordedBy: owner, note: "paid by UPI" });
      expect(PAYMENT_LINK).toBe("/fees");
      expect(await bellOf(c, s)).toEqual([
        { type: "payment_update", title: "Your fee payment was recorded.", body: null, link: "/fees", dedupKey: null },
      ]);
      expect(await bellOf(c, owner)).toEqual([]);
    }));

  it("takes today or any earlier date, with or without a note", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id);
      const a = await fee(c, s, { due: "1997-07-10" });
      const b = await fee(c, s, { due: "1997-07-20" });
      await markFeeInTransaction(c, a, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY);
      await markFeeInTransaction(c, b, owner, { status: "paid", paidOn: "1997-06-01", note: null }, TODAY); // paid early
      expect(await rowOf(c, a)).toMatchObject({ status: "paid", paidOn: TODAY, note: null });
      expect(await rowOf(c, b)).toMatchObject({ status: "paid", paidOn: "1997-06-01" });
    }));

  it("marks a fee pending again, clearing date, recorder and note, and notifies nobody", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id);
      const id = await fee(c, s, { due: "1997-07-10", paidOn: "1997-07-11", note: "paid by UPI" });

      const marked = await markFeeInTransaction(c, id, owner, { status: "pending" }, TODAY);

      expect(marked).toMatchObject({ id, status: "pending", paidOn: null, note: null });
      expect(await rowOf(c, id)).toEqual({ status: "pending", paidOn: null, recordedBy: null, note: null });
      expect(await bellOf(c, s)).toEqual([]);
    }));

  it("notifies again when a fee is marked paid again after an undo", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id);
      const id = await fee(c, s, { due: "1997-07-10" });
      await markFeeInTransaction(c, id, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY);
      await markFeeInTransaction(c, id, owner, { status: "pending" }, TODAY);
      await markFeeInTransaction(c, id, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY);
      expect(await bellOf(c, s)).toHaveLength(2);
    }));

  it("marks a moved-out student's fee paid without notifying them", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id, false);
      const id = await fee(c, s, { due: "1997-07-10" });
      await markFeeInTransaction(c, id, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY);
      expect((await rowOf(c, id)).status).toBe("paid");
      expect(await bellOf(c, s)).toEqual([]);
    }));

  it("refuses a date after today, a fee already in that state, and an unknown fee, writing nothing", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const s = await student(c, "Asha", (await newBuilding(c)).id);
      const pending = await fee(c, s, { due: "1997-07-10" });
      const paid = await fee(c, s, { due: "1997-07-01", paidOn: "1997-07-02", note: "cash" });

      expect(
        await refusal(markFeeInTransaction(c, pending, owner, { status: "paid", paidOn: "1997-07-16", note: null }, TODAY)),
      ).toEqual({ status: 400, code: "paid_on_in_future", message: "The payment date cannot be after today." });
      expect(
        await refusal(markFeeInTransaction(c, paid, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY)),
      ).toEqual({ status: 409, code: "fee_already_paid", message: "That fee is already marked paid." });
      expect(await refusal(markFeeInTransaction(c, pending, owner, { status: "pending" }, TODAY))).toEqual({
        status: 409,
        code: "fee_already_pending",
        message: "That fee is already pending.",
      });
      expect(await refusal(markFeeInTransaction(c, 999_999_999, owner, { status: "pending" }, TODAY))).toEqual({
        status: 404,
        code: "fee_not_found",
        message: "That fee does not exist.",
      });

      expect(await rowOf(c, pending)).toEqual({ status: "pending", paidOn: null, recordedBy: null, note: null });
      expect(await rowOf(c, paid)).toMatchObject({ status: "paid", paidOn: "1997-07-02", note: "cash" });
      expect(await bellOf(c, s)).toEqual([]);
    }));
});

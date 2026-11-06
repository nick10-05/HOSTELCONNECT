import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for fee rows (migration 012), so they hold even
// if a service function has a bug. Run as hostel_app, the role the app uses, inside
// transactions that are rolled back. The due-date rule itself is tests/fees.test.ts.
const db = testPool();
afterAll(() => db.end());

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

const DUE = "2026-11-14";

const CREATE = `INSERT INTO fees (student_id, due_date, amount) VALUES ($1, $2, $3) RETURNING id`;
async function feeRow(c: PoolClient, student: number, due = DUE, amount: number | null = 6500): Promise<number> {
  const { rows } = await c.query<{ id: number }>(CREATE, [student, due, amount]);
  return rows[0].id;
}

const MARK_PAID = `UPDATE fees SET status = 'paid', paid_on = $2, recorded_by = $3, note = $4 WHERE id = $1`;
const MARK_PENDING = `UPDATE fees SET status = 'pending', paid_on = NULL, recorded_by = NULL, note = NULL
                      WHERE id = $1`;

describe("fees", () => {
  it("records a new row as pending, created now, with the amount it was given", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const id = await feeRow(c, student);
      const { rows } = await c.query(
        `SELECT student_id, due_date, amount, status, paid_on, recorded_by, note,
                created_at = now() AS created_now
         FROM fees WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        student_id: student,
        due_date: DUE,
        amount: 6500,
        status: "pending",
        paid_on: null,
        recorded_by: null,
        note: null,
        created_now: true,
      });
    }));

  it("takes an amount of 0 or more, or none when the student has no fee set", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      await feeRow(c, student, "2026-11-14", null);
      await feeRow(c, student, "2026-12-14", 0);
      const err = await pgError(c, CREATE, [student, "2027-01-14", -1]);
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "fees_amount_check" });
    }));

  it("keeps one row per student per due date, so a repeated job run cannot add a second", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      await feeRow(c, student);

      const err = await pgError(c, CREATE, [student, DUE, 7000]);
      expect(err).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "fees_student_due_date" });
      await feeRow(c, other);
      await feeRow(c, student, "2026-12-14");
    }));

  it("needs a student who exists, a due date and an owner who exists when paid", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      expect((await pgError(c, CREATE, [999_999_999, DUE, 6500])).code).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(c, CREATE, [null, DUE, 6500])).code).toBe(NOT_NULL_VIOLATION);
      expect((await pgError(c, CREATE, [student, null, 6500])).code).toBe(NOT_NULL_VIOLATION);
      const id = await feeRow(c, student);
      expect((await pgError(c, MARK_PAID, [id, "2026-11-06", 999_999_999, null])).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    }));

  it("is pending or paid, nothing else", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const err = await pgError(
        c,
        `INSERT INTO fees (student_id, due_date, status) VALUES ($1, $2, 'overdue')`,
        [student, DUE],
      );
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "fees_status_check" });
    }));

  it("can be marked paid with a date, who recorded it and an optional note, and back to pending", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await feeRow(c, student);

      await c.query(MARK_PAID, [id, "2026-11-06", owner, "paid by UPI"]);
      let { rows } = await c.query(`SELECT status, paid_on, recorded_by, note FROM fees WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ status: "paid", paid_on: "2026-11-06", recorded_by: owner, note: "paid by UPI" });

      await c.query(MARK_PENDING, [id]);
      ({ rows } = await c.query(`SELECT status, paid_on, recorded_by, note FROM fees WHERE id = $1`, [id]));
      expect(rows[0]).toEqual({ status: "pending", paid_on: null, recorded_by: null, note: null });

      await c.query(MARK_PAID, [id, "2026-10-30", owner, null]);
    }));

  it("refuses a paid row without its date or recorder, and a pending row with any of them", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await feeRow(c, student);
      for (const [label, set, params] of [
        ["paid, no date", `status = 'paid', recorded_by = $2`, [owner]],
        ["paid, no recorder", `status = 'paid', paid_on = $2`, ["2026-11-06"]],
        ["pending with a date", `paid_on = $2`, ["2026-11-06"]],
        ["pending with a recorder", `recorded_by = $2`, [owner]],
        ["pending with a note", `note = $2`, ["paid by UPI"]],
      ] as const) {
        const err = await pgError(c, `UPDATE fees SET ${set} WHERE id = $1`, [id, ...params]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint: "fees_paid" });
      }
    }));

  it("takes a note of 1 to 200 characters, stored trimmed", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await feeRow(c, student);
      for (const [label, note] of [
        ["empty", ""],
        ["blank", " \n"],
        ["201 characters", "x".repeat(201)],
        ["201 emoji", "💸".repeat(201)],
        ["untrimmed", " paid by UPI"],
        ["line break at the end", "paid by UPI\n"],
      ] as const) {
        const err = await pgError(c, MARK_PAID, [id, "2026-11-06", owner, note]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint: "fees_note_check" });
      }
      for (const note of ["x", "x".repeat(200), "💸".repeat(200), "Paid in cash.\nReceipt 12."]) {
        await c.query(MARK_PAID, [id, "2026-11-06", owner, note]);
      }
    }));

  it("lets the app mark a row paid or pending, never change its student, due date or amount, or delete it", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      const id = await feeRow(c, student);
      for (const [sql, params] of [
        ["UPDATE fees SET student_id = $2 WHERE id = $1", [id, other]],
        ["UPDATE fees SET due_date = '2026-12-14' WHERE id = $1", [id]],
        ["UPDATE fees SET amount = 1 WHERE id = $1", [id]],
        ["UPDATE fees SET created_at = now() WHERE id = $1", [id]],
        ["DELETE FROM fees WHERE id = $1", [id]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  it("has the index for the owner's list by month and status", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'fees' AND indexname = 'fees_due_date_status'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain("(due_date, status)");
    }));
});

import type { PoolClient } from "pg";
import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { notify } from "./notifications";

// Fees (design doc, sections 3 and 9). Day 4 added the due-date rule; day 9 a student's
// own fees (getMyFees). The fee-rows job is jobs/feeRows.ts; reminders arrive on day 10.
// tests/fees.test.ts describes the due-date rule, tests/myFees.test.ts getMyFees,
// tests/ownerFees.test.ts the owner's list and marking a fee paid or pending.

// The nth due date of a student who joined on `joiningDate` (both 'YYYY-MM-DD'):
// the joining date plus n months, with the day clamped to the last day of that month.
//   joined 2026-01-14: n=1 2026-02-14, n=2 2026-03-14
//   joined 2026-01-31: n=1 2026-02-28, n=2 2026-03-31, n=3 2026-04-30
// Always counted from the joining date, never from the previous due date, which would
// drift to the 28th after the first short month.
// n is a whole number from 1 up; anything else is a bug in the caller, so it throws a
// RangeError (not an HttpError: no user input reaches this function unchecked).
export function nthDueDate(joiningDate: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("n must be a positive integer");
  }

  const [year, month, day] = joiningDate.split("-").map(Number);

  // Calculate the target month and year.
  const totalMonths = month - 1 + n;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;

  // Find the last day of the target month.
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth, 0)
  ).getUTCDate();

  // Clamp the joining day to the target month's last day.
  const targetDay = Math.min(day, lastDay);

  // Return YYYY-MM-DD.
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}
// The first due date on or after `today` (both 'YYYY-MM-DD'), shown on the profile.
// Walks the due dates in order; a student who joined years ago means at most a few
// hundred cheap steps. 'YYYY-MM-DD' text sorts like the dates it holds.
export function nextDueDate(joiningDate: string, today: string): string {
  let n = 1;
  while (nthDueDate(joiningDate, n) < today) n++;
  return nthDueDate(joiningDate, n);
}

// ---- A student's own fees (day 9; section 12 lists "balance calculation" under "You
// write"; Claude writes it at Nikhil's request, stub, contract and tests first) ----

export type FeeStatus = "pending" | "paid";

// One fee row as the student sees it. Dates are 'YYYY-MM-DD'; amounts are rupees, NULL
// when no fee was set when the row was created.
export type MyFeeRow = {
  id: number;
  dueDate: string;
  amount: number | null;
  status: FeeStatus;
  paidOn: string | null;
  note: string | null;
};

export type MyFees = {
  pendingBalance: number;
  amountNotSet: number;
  overdue: MyFeeRow[];
  upcoming: MyFeeRow[];
  history: MyFeeRow[];
  nextDueDate: string | null;
};

// GET /api/fees/mine: `studentId`'s own fees on `today` ('YYYY-MM-DD', India's date).
//   pendingBalance  the sum of the amounts of pending rows due on or before today (section
//                   3); a row with no amount adds nothing
//   amountNotSet    how many of those rows have no amount, so the screen can say so
//   overdue         pending rows due before today, oldest first
//   upcoming        pending rows due after today, soonest first
//   history         every row, paid or pending, newest due date first
//   nextDueDate     the first of the student's due dates on or after today (nextDueDate
//                   from their joining date), whether or not its row exists yet; null if
//                   the student has no joining date (never for a real student)
// A pending row due exactly today is in the balance but neither overdue nor upcoming.
// Rows with the same due date cannot exist (one per student and date); ties never arise.
// Only this student's rows; nothing about anyone else. Read-only.
export async function getMyFees(db: Queryable, studentId: number, today: string): Promise<MyFees> {
  const { rows: history } = await db.query<MyFeeRow>(
    `SELECT id, due_date AS "dueDate", amount, status, paid_on AS "paidOn", note
     FROM fees
     WHERE student_id = $1 AND hostel_id = current_hostel_id()
     ORDER BY due_date DESC`,
    [studentId],
  );
  const { rows: users } = await db.query<{ joiningDate: string | null }>(
    `SELECT joining_date AS "joiningDate" FROM users WHERE id = $1 AND hostel_id = current_hostel_id()`,
    [studentId],
  );
  const joiningDate = users[0]?.joiningDate ?? null;

  // 'YYYY-MM-DD' text sorts like the dates it holds.
  const pending = history.filter((r) => r.status === "pending");
  const dueByToday = pending.filter((r) => r.dueDate <= today);

  return {
    pendingBalance: dueByToday.reduce((sum, r) => sum + (r.amount ?? 0), 0),
    amountNotSet: dueByToday.filter((r) => r.amount === null).length,
    // history is newest first; these two read oldest (soonest) first.
    overdue: pending.filter((r) => r.dueDate < today).reverse(),
    upcoming: pending.filter((r) => r.dueDate > today).reverse(),
    history,
    nextDueDate: joiningDate === null ? null : nextDueDate(joiningDate, today),
  };
}

// ---- The owner's fee list and marking a fee (Claude) ----

// A fee row's state on a given day, computed, never stored (section 3):
//   paid      status 'paid'
//   overdue   pending, due before today
//   due       pending, due today
//   upcoming  pending, due after today
export type FeeState = "paid" | "overdue" | "due" | "upcoming";

// One row of the owner's list. building* are the student's current stay (NULL for a
// student who has moved out, whose isActive is false: the owner may still mark the fee).
export type OwnerFeeRow = {
  id: number;
  studentId: number;
  studentName: string;
  isActive: boolean;
  buildingId: number | null;
  buildingName: string | null;
  dueDate: string;
  amount: number | null;
  status: FeeStatus;
  state: FeeState;
  paidOn: string | null;
  note: string | null;
};

export type FeeTotal = { count: number; amount: number };
export type FeeTotals = { paid: FeeTotal; pending: FeeTotal; overdue: FeeTotal; amountNotSet: number };

export type FeeFilters = {
  month: string; // 'YYYY-MM', India's calendar: rows whose due date is in that month
  status: "paid" | "pending" | "overdue" | null; // overdue: pending and due before today
  buildingId: number | null; // the student's current stay
  page: number;
  limit: number;
};

// GET /api/fees: one page of the fee rows due in `filters.month`, with each row's state on
// `today` ('YYYY-MM-DD', India's date), ordered by due date, then student name ignoring case,
// then id; `total` counts every row matching all filters. `totals` sums the month's rows
// matching the building filter but not the status filter (the screen shows all three
// together): paid and pending (count and amount), overdue (a part of pending), and how many
// pending rows have no amount (they add nothing to any amount). The route checks the month,
// status, building, page and limit. Read-only.
export async function listFees(
  db: Queryable,
  filters: FeeFilters,
  today: string,
): Promise<{ items: OwnerFeeRow[]; total: number; totals: FeeTotals }> {
  // The month's rows (and building, when asked), each with its state on today. A moved-out
  // student has no current stay, so no building, and never matches a building filter.
  const monthRows = `
    SELECT f.id, f.student_id AS "studentId", u.name AS "studentName", u.is_active AS "isActive",
           s.building_id AS "buildingId", b.name AS "buildingName",
           f.due_date AS "dueDate", f.amount, f.status,
           CASE WHEN f.status = 'paid' THEN 'paid'
                WHEN f.due_date < $2::date THEN 'overdue'
                WHEN f.due_date = $2::date THEN 'due'
                ELSE 'upcoming' END AS state,
           f.paid_on AS "paidOn", f.note
    FROM fees f
    JOIN users u ON u.id = f.student_id
    LEFT JOIN stays s ON s.student_id = u.id AND s.ended_on IS NULL
    LEFT JOIN buildings b ON b.id = s.building_id
    WHERE f.hostel_id = current_hostel_id()
      AND f.due_date >= $1::date AND f.due_date < ($1::date + interval '1 month')
      AND ($3::bigint IS NULL OR s.building_id = $3)`;
  // The status filter, on top of those rows: 'paid' and 'overdue' are states, 'pending' is
  // the status (overdue, due and upcoming together).
  const matchesStatus = `($4::text IS NULL OR state = $4 OR status = $4)`;
  const params = [`${filters.month}-01`, today, filters.buildingId, filters.status];

  const { rows: sums } = await db.query<{
    total: number; paidCount: number; paidAmount: number; pendingCount: number; pendingAmount: number;
    overdueCount: number; overdueAmount: number; amountNotSet: number;
  }>(
    `SELECT count(*) FILTER (WHERE ${matchesStatus})::int AS total,
            count(*) FILTER (WHERE status = 'paid')::int AS "paidCount",
            coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0)::bigint AS "paidAmount",
            count(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
            coalesce(sum(amount) FILTER (WHERE status = 'pending'), 0)::bigint AS "pendingAmount",
            count(*) FILTER (WHERE state = 'overdue')::int AS "overdueCount",
            coalesce(sum(amount) FILTER (WHERE state = 'overdue'), 0)::bigint AS "overdueAmount",
            count(*) FILTER (WHERE status = 'pending' AND amount IS NULL)::int AS "amountNotSet"
     FROM (${monthRows}) r`,
    params,
  );
  const { rows: items } = await db.query<OwnerFeeRow>(
    `SELECT * FROM (${monthRows}) r
     WHERE ${matchesStatus}
     ORDER BY "dueDate", lower("studentName"), id
     LIMIT $5 OFFSET $6`,
    [...params, filters.limit, (filters.page - 1) * filters.limit],
  );

  const t = sums[0];
  return {
    items,
    total: t.total,
    totals: {
      paid: { count: t.paidCount, amount: t.paidAmount },
      pending: { count: t.pendingCount, amount: t.pendingAmount },
      overdue: { count: t.overdueCount, amount: t.overdueAmount },
      amountNotSet: t.amountNotSet,
    },
  };
}

// What the owner sends: paid, with the payment date (the route defaults it to India's
// today) and an optional note (trimmed, 1 to 200 characters, as migration 012 checks); or
// back to pending, which clears the date, who recorded it and the note.
export type FeeChange = { status: "paid"; paidOn: string; note: string | null } | { status: "pending" };

// A fee row as marking returns it.
export type MarkedFee = MyFeeRow & { studentId: number };

export const PAYMENT_LINK = "/fees";

// Exactly MarkedFee's fields.
const MARKED_COLUMNS = `id, student_id AS "studentId", due_date AS "dueDate", amount, status,
                        paid_on AS "paidOn", note`;

// Inside the caller's transaction: marks fee `feeId` paid (recorded by `ownerId`) or pending
// again. The UPDATE names the status it expects, so two clicks at once cannot both succeed.
// Marking paid notifies the student (notify reaches them only while active):
//   type 'payment_update', title "Your fee payment was recorded.", body null,
//   link PAYMENT_LINK ("/fees"), no dedup key (a fee marked paid again after an undo
//   notifies again)
// Back to pending notifies nobody (decided on day 9).
//   400 paid_on_in_future    "The payment date cannot be after today."   (`today`, India)
//   404 fee_not_found        "That fee does not exist."
//   409 fee_already_paid     "That fee is already marked paid."
//   409 fee_already_pending  "That fee is already pending."
// Nothing is written on any refusal. Returns the row as it is now.
export async function markFeeInTransaction(
  c: Queryable,
  feeId: number,
  ownerId: number,
  change: FeeChange,
  today: string,
): Promise<MarkedFee> {
  // 'YYYY-MM-DD' text sorts like the dates it holds.
  if (change.status === "paid" && change.paidOn > today) {
    throw new HttpError(400, "paid_on_in_future", "The payment date cannot be after today.");
  }

  // Each UPDATE names the status it expects, so it changes nothing if the fee is already in
  // the new state, or if another click got there first.
  const { rows } =
    change.status === "paid"
      ? await c.query<MarkedFee>(
          `UPDATE fees SET status = 'paid', paid_on = $2, recorded_by = $3, note = $4
           WHERE id = $1 AND status = 'pending' AND hostel_id = current_hostel_id()
           RETURNING ${MARKED_COLUMNS}`,
          [feeId, change.paidOn, ownerId, change.note],
        )
      : await c.query<MarkedFee>(
          `UPDATE fees SET status = 'pending', paid_on = NULL, recorded_by = NULL, note = NULL
           WHERE id = $1 AND status = 'paid' AND hostel_id = current_hostel_id()
           RETURNING ${MARKED_COLUMNS}`,
          [feeId],
        );

  if (rows.length === 0) {
    // Nothing changed: say why.
    const { rowCount } = await c.query(`SELECT 1 FROM fees WHERE id = $1 AND hostel_id = current_hostel_id()`, [feeId]);
    if (!rowCount) throw new HttpError(404, "fee_not_found", "That fee does not exist.");
    throw change.status === "paid"
      ? new HttpError(409, "fee_already_paid", "That fee is already marked paid.")
      : new HttpError(409, "fee_already_pending", "That fee is already pending.");
  }

  const fee = rows[0];
  if (change.status === "paid") {
    await notify(c, [fee.studentId], {
      type: "payment_update",
      title: "Your fee payment was recorded.",
      body: null,
      link: PAYMENT_LINK,
    });
  }
  return fee;
}

// Marks a fee, all or nothing: the core above in one transaction.
export async function markFee(
  db: Db,
  feeId: number,
  ownerId: number,
  change: FeeChange,
  today: string,
): Promise<MarkedFee> {
  return inTransaction(db, (c) => markFeeInTransaction(c, feeId, ownerId, change, today));
}

// ---- Helper ----

// Runs `fn` in one transaction on its own client: COMMIT when it returns, ROLLBACK when
// it throws (the error is passed on), and the client always goes back to the pool. The
// same helper as in services/announcements.ts.
async function inTransaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  try {
    await c.query("BEGIN");
    transactionStarted = true;
    const result = await fn(c);
    await c.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

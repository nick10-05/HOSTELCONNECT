import type { Queryable } from "../db";
import { notify } from "../services/notifications";

// The fee-reminders job (design doc, sections 9 and 10), run by POST /api/internal/run-jobs
// every hour, after the fee-rows job. Written by Claude at Nikhil's request (section 12 lists
// "reminder timing" under "You write"). tests/feeReminders.test.ts describes it.
//
// Section 9: "Each student is reminded once 3 days before the due date, on the due date, and
// 3 days after if still pending." Each reminder belongs to a window of days, not one day, so a
// run that comes late (GitHub's schedule slips, the server sleeps) still sends it, and each
// window is closed, so no reminder is ever sent twice (decided on day 10):
//   before   due date - 3 .. due date - 1   "Fee due in N days"
//   due      due date     .. due date + 2   "Fee due today"
//   overdue  due date + 3 .. due date + 9   "Fee overdue"
// The windows are closed because the prune job deletes notifications after 60 days, and with
// them their dedup keys: an open "overdue while pending" rule would remind again after that.

export type ReminderStage = "before" | "due" | "overdue";

export type FeeRemindersResult = { created: number };

export const FEE_REMINDER_LINK = "/fees";

// Which reminder a fee due on `dueDate` gets on `today` (both India's dates, 'YYYY-MM-DD'),
// by the windows above; null outside them. Says nothing about whether it is paid.
export function reminderStage(dueDate: string, today: string): ReminderStage | null {
  const after = daysBetween(dueDate, today);
  if (after >= -3 && after <= -1) return "before";
  if (after >= 0 && after <= 2) return "due";
  if (after >= 3 && after <= 9) return "overdue";
  return null;
}

// How many days `to` is after `from` (negative: before). Both are read as UTC midnights,
// where every day is exactly 24 hours (lib/dates.ts, addDays).
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// The windows' outer edges, for the query: nothing due later or earlier can be in one.
const FIRST_DAY_BEFORE = 3;
const LAST_DAY_AFTER = 9;

// Month names written out, not from Intl: some ICU versions spell September "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// '1998-04-14' as "14 Apr 1998".
function showDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[month - 1]} ${year}`;
}

// The reminder's title and body for a fee of `amount` rupees (null: not set) due on `dueDate`.
function reminderText(stage: ReminderStage, dueDate: string, today: string, amount: number | null) {
  const what = amount === null ? "Your fee" : `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
  switch (stage) {
    case "before": {
      const left = daysBetween(today, dueDate);
      return {
        title: `Fee due in ${left} ${left === 1 ? "day" : "days"}`,
        body: `${what} is due on ${showDate(dueDate)}.`,
      };
    }
    case "due":
      return { title: "Fee due today", body: `${what} is due today.` };
    case "overdue":
      return { title: "Fee overdue", body: `${what} was due on ${showDate(dueDate)} and is still pending.` };
  }
}

// Creates today's reminder for every pending fee whose due date puts it in a window, for
// active students only (notify reaches nobody else), at most one per fee and stage:
//   type 'fee_reminder', link FEE_REMINDER_LINK, dedup key `fee:<fee id>:<stage>`
//   before   title "Fee due in 3 days" ("in 1 day" when one is left)
//            body  "₹6,500 is due on 14 Apr 2026."
//   due      title "Fee due today"
//            body  "₹6,500 is due today."
//   overdue  title "Fee overdue"
//            body  "₹6,500 was due on 14 Apr 2026 and is still pending."
// The amount is in Indian grouping (₹1,00,000). A fee with no amount set says "Your fee"
// instead ("Your fee is due on 14 Apr 2026."); a fee of ₹0 gets no reminder. Only the stage
// for today is sent: a fee first seen on its due date gets "due" and never "before". Each
// fee is separate, so a student with two pending fees gets a reminder for each. A paid fee
// gets nothing, whatever the day. `today` is India's date. Returns how many notifications
// were created.
export async function sendFeeReminders(
  db: Queryable,
  opts: { today: string },
): Promise<FeeRemindersResult> {
  // Every pending fee of an active student that could be in a window today; the stage is
  // then worked out here, in one place, by reminderStage.
  const { rows } = await db.query<{ id: number; studentId: number; dueDate: string; amount: number | null }>(
    `SELECT f.id, f.student_id AS "studentId", f.due_date AS "dueDate", f.amount
     FROM fees f
     JOIN users u ON u.id = f.student_id
     WHERE f.status = 'pending' AND f.hostel_id = current_hostel_id()
       AND (f.amount IS NULL OR f.amount > 0)
       AND u.is_active
       AND f.due_date BETWEEN $1::date - $2::int AND $1::date + $3::int
     ORDER BY f.due_date, f.id`,
    [opts.today, LAST_DAY_AFTER, FIRST_DAY_BEFORE],
  );

  let created = 0;
  for (const fee of rows) {
    const stage = reminderStage(fee.dueDate, opts.today);
    if (!stage) continue;
    created += await notify(db, [fee.studentId], {
      type: "fee_reminder",
      ...reminderText(stage, fee.dueDate, opts.today, fee.amount),
      link: FEE_REMINDER_LINK,
      dedupKey: `fee:${fee.id}:${stage}`,
    });
  }
  return { created };
}

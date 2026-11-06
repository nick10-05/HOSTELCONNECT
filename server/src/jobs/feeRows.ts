import type { Queryable } from "../db";

// The fee-rows job (design doc, sections 3, 9 and 10), run by POST /api/internal/run-jobs
// every hour. Written by Claude at Nikhil's request (section 12 lists "fee row creation by
// joining date" under "You write"). tests/feeRows.test.ts describes it.

// How far ahead a row is created: a fee row appears once its due date is within 7 days
// (section 9), so the student sees it as "upcoming" a week early.
export const FEE_ROW_DAYS_AHEAD = 7;

export type FeeRowsResult = { created: number };

// Creates every missing fee row that is due, for every active student (role 'student',
// is_active). A row is due for a due date d when
//   - d is one of the student's due dates: their joining date plus n months (n = 1, 2, ...),
//     the day clamped to the month's last day, always counted from the joining date
//     (services/fees.ts, nthDueDate). The joining date itself is never a due date.
//   - startDate <= d: no rows before go-live (FEES_START_DATE); earlier payments stay in
//     the owner's record book (section 9).
//   - d <= today + FEE_ROW_DAYS_AHEAD (`today` is India's date).
// Every such date gets a row, not only the next one (decided on day 9): if the job has not
// run for a while, no month is skipped.
// A new row is pending, with amount = the student's monthly_fee at that moment (NULL when
// none is set). An existing row for the same student and due date is left as it is, paid
// or not, whatever the fee is now (fees_student_due_date; ON CONFLICT DO NOTHING), so a
// repeated or overlapping run is harmless. Students who are not active get no new rows;
// their existing rows stay. A student whose joining date changed (a rejoin) follows the new
// date only. Returns how many rows were created. Nobody is notified (reminders are day 10).
export async function createDueFeeRows(
  db: Queryable,
  opts: { today: string; startDate: string },
): Promise<FeeRowsResult> {
  // One INSERT for everyone. For each active student, n runs from 1 to the number of
  // calendar months between the joining date's month and the window's last month: n months
  // after joining falls in that many months later, so no larger n can be in the window. A
  // joining date after the window gives an empty series. Postgres adds n months to the
  // joining date and clamps the day to the month's end (31 Jan + 1 month = 28 Feb, + 2
  // months = 31 Mar), the same rule as nthDueDate, counted from the joining date each time.
  const { rowCount } = await db.query(
    `INSERT INTO fees (student_id, due_date, amount)
     SELECT u.id, d.due, u.monthly_fee
     FROM users u
     CROSS JOIN LATERAL (
       SELECT (u.joining_date + make_interval(months => n))::date AS due
       FROM generate_series(
              1,
              ((date_part('year', $1::date + $3::int) - date_part('year', u.joining_date)) * 12
               + date_part('month', $1::date + $3::int) - date_part('month', u.joining_date))::int
            ) AS n
     ) d
     WHERE u.role = 'student' AND u.is_active AND u.joining_date IS NOT NULL
       AND d.due >= $2::date
       AND d.due <= $1::date + $3::int
     ON CONFLICT (student_id, due_date) DO NOTHING`,
    [opts.today, opts.startDate, FEE_ROW_DAYS_AHEAD],
  );
  return { created: rowCount ?? 0 };
}

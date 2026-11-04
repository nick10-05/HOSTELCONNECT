// Fees (design doc, sections 3 and 9). Day 4 adds only the due-date rule; fee rows,
// balances and reminders arrive on day 9. tests/fees.test.ts describes what it must do.

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

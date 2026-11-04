// Calendar days as 'YYYY-MM-DD' text, the same form Postgres DATE columns use (db.ts).
// The hostel is in India, so "today" is India's date, whatever zone the server runs in
// (Render's containers run in UTC, which is 5 h 30 min behind).

export const HOSTEL_TIME_ZONE = "Asia/Kolkata";

// Today's date in the hostel's time zone. `now` is for tests.
export function hostelToday(now: Date = new Date()): string {
  // The en-CA locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOSTEL_TIME_ZONE }).format(now);
}

// The day `days` days after `day` (negative goes back). Done in UTC, where every day
// is exactly 24 hours, so no daylight-saving shift can skip or repeat a day.
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

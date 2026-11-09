import type { Queryable } from "../db";
import { hostelHour, hostelToday } from "../lib/dates";
import { notify } from "../services/notifications";

// The owner's daily digest (design doc, sections 9 and 10), run by POST /api/internal/run-jobs
// every hour. Written by Claude at Nikhil's request (section 12 lists "digest content" under
// "You write"). tests/digest.test.ts describes it.
//
// Section 9: "The owner receives one digest notification a day, created by the first job run
// after 8 am India time: pending complaints, pending rejoin requests, fees due in 3 days, and
// overdue fees. Nothing is sent when all are zero." It is the owner's only notification: he
// is never notified per complaint or request (section 1).

// The first hour on India's clock at which a run creates the day's digest.
export const DIGEST_HOUR = 8;

// How far ahead "fees due soon" looks, in days after today.
export const DIGEST_FEE_DAYS_AHEAD = 3;

export const DIGEST_LINK = "/";

// The digest's numbers on `today` (India's date). The same rules as the dashboard
// (services/dashboard.ts), so the two never disagree:
//   complaints       open or in progress, every student's, moved out or not
//   rejoinRequests   pending
//   feesDueSoon      pending fees due from today to today + DIGEST_FEE_DAYS_AHEAD
//   feesOverdue      pending fees due before today
// Fees count whoever owes them, moved out or not, as on the dashboard.
export type DigestCounts = {
  complaints: number;
  rejoinRequests: number;
  feesDueSoon: number;
  feesOverdue: number;
};

export async function digestCounts(db: Queryable, today: string): Promise<DigestCounts> {
  const { rows } = await db.query<DigestCounts>(
    `SELECT
       (SELECT count(*)::int FROM complaints WHERE status IN ('open', 'in_progress') AND hostel_id = current_hostel_id()) AS complaints,
       (SELECT count(*)::int FROM rejoin_requests WHERE status = 'pending' AND hostel_id = current_hostel_id()) AS "rejoinRequests",
       (SELECT count(*)::int FROM fees
        WHERE status = 'pending' AND hostel_id = current_hostel_id()
          AND due_date BETWEEN $1::date AND $1::date + $2::int) AS "feesDueSoon",
       (SELECT count(*)::int FROM fees
        WHERE status = 'pending' AND hostel_id = current_hostel_id() AND due_date < $1::date) AS "feesOverdue"`,
    [today, DIGEST_FEE_DAYS_AHEAD],
  );
  return rows[0];
}

// "1 pending complaint", "2 pending complaints".
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The digest's title and body, or null when every count is zero (nothing is sent). Only the
// counts that are not zero are named, in this order, singular for one:
//   title "Your daily summary"
//   body  "2 pending complaints, 1 rejoin request, 3 fees due in the next 3 days, 1 overdue fee."
export function digestText(counts: DigestCounts): { title: string; body: string } | null {
  const parts = [
    counts.complaints && counted(counts.complaints, "pending complaint", "pending complaints"),
    counts.rejoinRequests && counted(counts.rejoinRequests, "rejoin request", "rejoin requests"),
    counts.feesDueSoon &&
      counted(counts.feesDueSoon, "fee", "fees") + ` due in the next ${DIGEST_FEE_DAYS_AHEAD} days`,
    counts.feesOverdue && counted(counts.feesOverdue, "overdue fee", "overdue fees"),
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return { title: "Your daily summary", body: `${parts.join(", ")}.` };
}

export type DigestResult = { created: number };

// At `now`: once India's clock has reached DIGEST_HOUR, creates the day's digest for every
// active owner, with type 'daily_digest', link DIGEST_LINK and dedup key
// `digest:<India's date>`, so later runs that day create nothing. Before DIGEST_HOUR, or
// when every count is zero, it creates nothing; a day that was all zeros at 8 am still gets
// a digest from a later run that day if something becomes pending. Returns how many
// notifications were created.
export async function sendDailyDigest(db: Queryable, opts: { now: Date }): Promise<DigestResult> {
  if (hostelHour(opts.now) < DIGEST_HOUR) return { created: 0 };

  const today = hostelToday(opts.now);
  const text = digestText(await digestCounts(db, today));
  if (!text) return { created: 0 };

  const { rows: owners } = await db.query<{ id: number }>(
    `SELECT id FROM users WHERE role = 'owner' AND is_active AND hostel_id = current_hostel_id()`,
  );
  const created = await notify(
    db,
    owners.map((o) => o.id),
    { type: "daily_digest", ...text, link: DIGEST_LINK, dedupKey: `digest:${today}` },
  );
  return { created };
}

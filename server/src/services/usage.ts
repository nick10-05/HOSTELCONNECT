import type { Queryable } from "../db";
import { hostelToday } from "../lib/dates";

// The usage guard (design doc, section 10): how much of the free Supabase Storage limits
// the photos use, and whether photo uploads are still allowed. Usage is computed whenever
// it is needed (dashboard load, every upload); there is no monitoring job.
// tests/usage.test.ts describes it.

// The thresholds (section 10). The dashboard card turns amber at AMBER_PERCENT of either
// limit; photo uploads switch off at UPLOADS_OFF_PERCENT of either. After
// DELETE_WARNING_ATTEMPTS failed deletions of one photo, the dashboard shows a warning.
export const AMBER_PERCENT = 70;
export const UPLOADS_OFF_PERCENT = 85;
export const DELETE_WARNING_ATTEMPTS = 5;

// From config: STORAGE_LIMIT_MB and EGRESS_LIMIT_MB. One MB is 1024 * 1024 bytes, as for
// PHOTO_MAX_BYTES.
export type UsageLimits = { storageLimitMb: number; egressLimitMb: number };

export type UsageLevel = "ok" | "amber" | "uploads_off";

export type Usage = {
  storage: { usedBytes: number; limitBytes: number; percent: number };
  hostelStorage: { usedBytes: number; limitBytes: number; percent: number };
  egress: { month: string; usedBytes: number; limitBytes: number; percent: number };
  level: UsageLevel;
  uploadsAllowed: boolean;
  failingDeletions: number;
};

// The usage_counters key for the egress of the month `now` falls in, in India's calendar
// (decided on day 8): 'egress:YYYY-MM'. A new month starts at midnight India time, which
// is 18:30 UTC on the last day of the month before. Pure: no database.
export function egressKey(now: Date): string {
  // India's date as 'YYYY-MM-DD'; its first seven characters are the month.
  return `egress:${hostelToday(now).slice(0, 7)}`;
}

// The usage at `now`, against `limits`. Read-only.
//
// storage.usedBytes   the sum of photo_size_bytes over complaints whose photo exists and is
//                     not yet deleted (photo_path set, photo_deleted_at empty), every
//                     hostel's, expired or not: an expired photo uses storage until the
//                     job confirms its deletion. 0 when there are none.
// hostelStorage       the same for this hostel's photos only, against its equal share of
//                     the storage limit (phase 5b): the limit divided by the number of
//                     active hostels, rounded down to a byte. With one hostel, the whole
//                     limit. One busy hostel cannot use up the bucket for the others.
// egress.month        'YYYY-MM' of `now` in India's calendar.
// egress.usedBytes    the value of that month's counter in usage_counters (egressKey);
//                     0 when the month has no row yet.
// limitBytes          the limit in MB times 1024 * 1024.
// percent             usedBytes as a percentage of limitBytes, rounded DOWN to a whole
//                     number (69.99 is 69, so the card never says 70 while still ok).
//                     It can pass 100.
// level               "uploads_off" when either percent is UPLOADS_OFF_PERCENT or more;
//                     otherwise "amber" when either is AMBER_PERCENT or more; otherwise
//                     "ok". The worst of storage, hostelStorage and egress decides.
// uploadsAllowed      false exactly when level is "uploads_off". The guard looks at usage
//                     as it is now, without the photo being uploaded (decided on day 8).
// failingDeletions    how many photos that are not yet deleted have failed to delete
//                     DELETE_WARNING_ATTEMPTS times or more (photo_delete_attempts).
export async function getUsage(db: Queryable, limits: UsageLimits, now: Date): Promise<Usage> {
  const key = egressKey(now);
  // One query, so storage, failures and egress are read at the same moment. Storage and
  // egress are the whole platform's (one shared bucket): photo_storage_bytes() counts every
  // hostel's photos (migration 018), and usage_counters belongs to no hostel. Failing
  // deletions are this hostel's own, for its owner's dashboard.
  const { rows } = await db.query<{ stored: number; own: number; hostels: number; failing: number; egress: number }>(
    `SELECT photo_storage_bytes() AS stored,
            (SELECT coalesce(sum(photo_size_bytes), 0)::bigint FROM complaints
             WHERE hostel_id = current_hostel_id()
               AND photo_path IS NOT NULL AND photo_deleted_at IS NULL) AS own,
            (SELECT count(*)::int FROM hostels WHERE status = 'active') AS hostels,
            (SELECT count(*)::int FROM complaints
             WHERE hostel_id = current_hostel_id()
               AND photo_path IS NOT NULL AND photo_deleted_at IS NULL
               AND photo_delete_attempts >= $2) AS failing,
            coalesce((SELECT value FROM usage_counters WHERE key = $1), 0)::bigint AS egress`,
    [key, DELETE_WARNING_ATTEMPTS],
  );
  const { stored, own, hostels, failing, egress } = rows[0];

  const storage = share(stored, limits.storageLimitMb);
  const shareBytes = Math.floor((limits.storageLimitMb * 1024 * 1024) / Math.max(hostels, 1));
  const hostelStorage = { usedBytes: own, limitBytes: shareBytes, percent: Math.floor((own * 100) / shareBytes) };
  const monthly = { month: key.slice("egress:".length), ...share(egress, limits.egressLimitMb) };

  // A floored percentage reaches a threshold exactly when the exact one does, so the
  // thresholds can be compared with the whole numbers the card shows.
  const worst = Math.max(storage.percent, hostelStorage.percent, monthly.percent);
  const level: UsageLevel =
    worst >= UPLOADS_OFF_PERCENT ? "uploads_off" : worst >= AMBER_PERCENT ? "amber" : "ok";

  return {
    storage,
    hostelStorage,
    egress: monthly,
    level,
    uploadsAllowed: level !== "uploads_off",
    failingDeletions: failing,
  };
}

// Bytes used against a limit in MB, with the percentage rounded down.
function share(usedBytes: number, limitMb: number) {
  const limitBytes = limitMb * 1024 * 1024;
  return { usedBytes, limitBytes, percent: Math.floor((usedBytes * 100) / limitBytes) };
}

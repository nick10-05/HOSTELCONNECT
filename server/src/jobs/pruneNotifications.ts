import type { Queryable } from "../db";

// The prune job (design doc, sections 3 and 10), run by POST /api/internal/run-jobs every
// hour, last. tests/pruneNotifications.test.ts describes it.

// Section 3: "rows older than 60 days are pruned by the job".
export const NOTIFICATION_DAYS_KEPT = 60;

export type PruneResult = { deleted: number };

// Deletes every notification created more than NOTIFICATION_DAYS_KEPT days before `now`,
// read or not, whoever it belongs to. One exactly 60 days old stays until the next run.
// Their dedup keys go with them, which is why the fee reminders' windows are closed
// (jobs/feeReminders.ts). Returns how many were deleted.
export async function pruneNotifications(db: Queryable, opts: { now: Date }): Promise<PruneResult> {
  const { rowCount } = await db.query(
    `DELETE FROM notifications WHERE hostel_id = current_hostel_id() AND created_at < $1::timestamptz - make_interval(days => $2)`,
    [opts.now, NOTIFICATION_DAYS_KEPT],
  );
  return { deleted: rowCount ?? 0 };
}

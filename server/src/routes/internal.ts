import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { withHostel, type Db } from "../db";
import { sendDailyDigest } from "../jobs/digest";
import { expirePhotos } from "../jobs/expirePhotos";
import { sendFeeReminders } from "../jobs/feeReminders";
import { createDueFeeRows } from "../jobs/feeRows";
import { pruneNotifications } from "../jobs/pruneNotifications";
import { hostelToday } from "../lib/dates";
import { sendError } from "../lib/http";
import type { PhotoStorage } from "../lib/storage";
import { requireJobSecret } from "../middleware/jobSecret";

export type InternalRouteDeps = {
  db: Db;
  jobSecret: string | undefined;
  storage: PhotoStorage | null;
  clock: () => Date;
};

// POST /api/internal/run-jobs (design doc, sections 5, 8 and 10): the scheduled jobs,
// called a few minutes past every hour by .github/workflows/jobs.yml with the secret
// header. No session: GitHub has none. Every job is idempotent and works on what is due,
// so a late, repeated or replayed call does no harm. The jobs run one after another:
// expiring photos (day 8), fee rows (day 9; only with FEES_START_DATE, else feeRows is
// null), then fee reminders, the owner's daily digest and pruning old notifications
// (day 10). Reminders come after fee rows, so a row created in this call is reminded in it;
// they run without FEES_START_DATE too, as they only look at rows that exist. Pruning comes
// last. Any failure answers 500 (decided on day 9), and GitHub emails about the failed run.
// The answer holds counts only, never a path or a link.
//
// Multi-tenant (phase 2b): the jobs run for every hostel in turn, oldest first, each
// hostel's in transactions marked with it (withHostel), and the answer adds the counts
// up. A hostel whose jobs fail does not stop the others: the error is logged with the
// hostel's id, the next hostel runs, and the call answers 500 at the end. Each hostel
// gets fee rows from its own start date (hostels.fees_start_date, phase 5a); a hostel
// without one gets none.

export function internalRouter(deps: InternalRouteDeps): Router {
  const { db, jobSecret, storage, clock } = deps;
  const router = Router();

  // 10 calls per 15 minutes, counted for all callers together: GitHub's runners call
  // from changing addresses, and the hourly schedule needs one. Counted before the
  // secret check, so guessing the secret is limited too. Created per router, so every
  // app (and every test) has its own counter.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyGenerator: () => "run-jobs",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", "Too many job runs. Try again in 15 minutes."),
  });

  router.post("/internal/run-jobs", limiter, requireJobSecret(jobSecret), async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const now = clock();
    const today = hostelToday(now);
    const expired = { deleted: 0, failed: 0 };
    const feeRows = { created: 0 };
    const feeReminders = { created: 0 };
    const digest = { created: 0 };
    const pruned = { deleted: 0 };
    let failedHostels = 0;

    const { rows: hostels } = await db.query<{ id: number; feesStartDate: string | null }>(
      `SELECT id, to_char(fees_start_date, 'YYYY-MM-DD') AS "feesStartDate" FROM hostels ORDER BY id`,
    );
    for (const { id: hostelId, feesStartDate } of hostels) {
      try {
        // Photos first and on their own: each photo is its own transaction.
        const photos = await expirePhotos(db, storage, { hostelId, now });
        expired.deleted += photos.deleted;
        expired.failed += photos.failed;
        await withHostel(db, hostelId, async (tx) => {
          if (feesStartDate) {
            feeRows.created += (await createDueFeeRows(tx, { today, startDate: feesStartDate })).created;
          }
          feeReminders.created += (await sendFeeReminders(tx, { today })).created;
          digest.created += (await sendDailyDigest(tx, { now })).created;
          pruned.deleted += (await pruneNotifications(tx, { now })).deleted;
        });
      } catch (err) {
        failedHostels += 1;
        console.error(`run-jobs: the jobs of hostel ${hostelId} failed`, err);
      }
    }

    if (failedHostels > 0) {
      sendError(res, 500, "jobs_failed", `The jobs of ${failedHostels} hostel(s) failed.`);
      return;
    }
    res.json({ expirePhotos: expired, feeRows, feeReminders, digest, pruned });
  });

  return router;
}

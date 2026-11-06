import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Db } from "../db";
import { expirePhotos } from "../jobs/expirePhotos";
import { createDueFeeRows } from "../jobs/feeRows";
import { hostelToday } from "../lib/dates";
import { sendError } from "../lib/http";
import type { PhotoStorage } from "../lib/storage";
import { requireJobSecret } from "../middleware/jobSecret";

export type InternalRouteDeps = {
  db: Db;
  jobSecret: string | undefined;
  // FEES_START_DATE; undefined: the fee-rows job does not run.
  feesStartDate?: string;
  storage: PhotoStorage | null;
  clock: () => Date;
};

// POST /api/internal/run-jobs (design doc, sections 5, 8 and 10): the scheduled jobs,
// called a few minutes past every hour by .github/workflows/jobs.yml with the secret
// header. No session: GitHub has none. Every job is idempotent and works on what is due,
// so a late, repeated or replayed call does no harm. The jobs run one after another:
// expiring photos (day 8), then fee rows (day 9; only with FEES_START_DATE, else feeRows
// is null). Any failure answers 500 (decided on day 9), and GitHub emails about the failed
// run. Reminders, the digest and pruning come on day 10. The answer holds counts only,
// never a path or a link.
export function internalRouter(deps: InternalRouteDeps): Router {
  const { db, jobSecret, feesStartDate, storage, clock } = deps;
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
    const expired = await expirePhotos(db, storage, { now });
    const feeRows = feesStartDate
      ? await createDueFeeRows(db, { today: hostelToday(now), startDate: feesStartDate })
      : null;
    res.json({ expirePhotos: expired, feeRows });
  });

  return router;
}

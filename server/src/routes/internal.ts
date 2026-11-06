import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Db } from "../db";
import { expirePhotos } from "../jobs/expirePhotos";
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
// so a late, repeated or replayed call does no harm. On day 8 the only job is expiring
// photos (decided on day 8); fee rows, reminders, the digest and pruning come on days 9
// and 10. The answer holds counts only, never a path or a link.
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
    const expired = await expirePhotos(db, storage, { now: clock() });
    res.json({ expirePhotos: expired });
  });

  return router;
}

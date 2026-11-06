import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { sendError } from "../lib/http";

// The header GitHub Actions sends to POST /api/internal/run-jobs (section 8).
export const JOB_SECRET_HEADER = "X-Job-Secret";

// Lets a request through only when it carries the job secret (JOB_SECRET) in the
// X-Job-Secret header. A missing or wrong secret answers 401, the same either way.
//
// The comparison takes the same time however much of the secret is right: both are
// hashed first, so the two values compared always have the same length, then compared
// with timingSafeEqual. A plain === stops at the first wrong character, and timing that
// over many tries could reveal the secret bit by bit.
//
// Without a JOB_SECRET (local development) the endpoint does not exist: 404, as for any
// unknown /api path.
export function requireJobSecret(secret: string | undefined): RequestHandler {
  const expected = secret === undefined ? undefined : digest(secret);
  return (req, res, next) => {
    if (!expected) {
      sendError(res, 404, "not_found", "No such endpoint");
      return;
    }
    const given = req.get(JOB_SECRET_HEADER);
    if (given !== undefined && timingSafeEqual(digest(given), expected)) {
      next();
      return;
    }
    sendError(res, 401, "invalid_job_secret", "Not allowed.");
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Db } from "../db";
import { parseBody, sendError } from "../lib/http";
import { requestRejoin } from "../services/rejoin";

// The public "Request access" form (design doc, sections 5 and 8): a former student
// cannot log in, so this is the one write anyone may send without a session.
// The rules that keep it from telling anyone who lives, or lived, here:
// - the answer is always the same 202 and the same sentence, whoever the email is;
// - the per-email limit counts every request, known email or not, so even a 429 says
//   nothing about the email;
// - the message is checked here at least as strictly as the database checks it
//   (migration 008), so the database never refuses one for a real former student only.

// Decided on day 5. Counted in this server's memory, like the login limit, so the counts
// reset when the free server sleeps or restarts.
export const REJOIN_LIMIT_PER_IP = 10; // per hour
export const REJOIN_LIMIT_PER_EMAIL = 3; // per 24 hours
export const REJOIN_ANSWER = "If this email belongs to a former student, the owner will review the request.";

export const rejoinSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("must be a valid email address")),
  message: z
    .string()
    .trim()
    // JavaScript counts an emoji as 2, the database as 1, so this is never looser.
    .max(500, "can be at most 500 characters")
    // Postgres text cannot hold a NUL character; refuse it here rather than fail later.
    .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
    .optional()
    .transform((s) => s || null),
});

const tooMany = "Too many requests from here. Please try again later.";

// The email the limit counts: the cleaned address, hashed so this memory never holds
// email addresses. A body without a usable email is counted under one shared key.
function emailKey(req: Request): string {
  const raw: unknown = req.body?.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return `email:${createHash("sha256").update(email).digest("hex")}`;
}

// Created per router, so every app (and every test) has its own counters.
export function rejoinRouter({ db }: { db: Db }): Router {
  const router = Router();

  const perIp = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: REJOIN_LIMIT_PER_IP,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", tooMany),
  });
  const perEmail = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: REJOIN_LIMIT_PER_EMAIL,
    keyGenerator: emailKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", tooMany),
  });

  router.post("/rejoin-requests", perIp, perEmail, async (req, res) => {
    const body = parseBody(rejoinSchema, req, res);
    if (!body) return;
    await requestRejoin(db, body.email, body.message);
    res.status(202).json({ message: REJOIN_ANSWER });
  });

  return router;
}

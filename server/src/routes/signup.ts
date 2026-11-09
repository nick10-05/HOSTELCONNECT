import { Router, type CookieOptions, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { Db } from "../db";
import { parseBody, sendError } from "../lib/http";
import { TERMS_VERSION } from "../lib/legal";
import { SESSION_TTL_SECONDS, signSession } from "../lib/token";
import { SESSION_COOKIE } from "../middleware/auth";
import { checkSlug, createHostelWithOwner } from "../services/hostels";
import { sessionCookieOptions } from "./auth";

// Sign-up (multi-tenant phase 4a). It starts at Google: a Google account no owner has
// linked, while sign-up is open, comes back from /api/auth/google/callback with a sign-up
// ticket (a signed, httpOnly cookie holding the Google account's id and verified email)
// and is sent to the sign-up page, which then uses:
//
//   GET  /api/signup            the email the account will have, and the terms version
//   GET  /api/signup/slug?slug  whether a hostel may take this address
//   POST /api/signup            creates the hostel and its owner, and signs the owner in
//
// SIGNUPS_OPEN switches all of it off (the default) until the legal documents are reviewed.
export const SIGNUP_COOKIE = "hc_signup";
const SIGNUP_PATH = "/api/signup";
const SIGNUP_SECONDS = 30 * 60;
const SIGNUP_AUDIENCE = "hostelconnect-signup";

type Ticket = { sub: string; email: string };

export function signupCookieOptions(secureCookies: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: secureCookies, path: SIGNUP_PATH };
}

// Called by the Google callback for an unknown Google account while sign-up is open.
export function giveSignupTicket(res: Response, ticket: Ticket, jwtSecret: string, secureCookies: boolean) {
  res.cookie(
    SIGNUP_COOKIE,
    jwt.sign(ticket, jwtSecret, { algorithm: "HS256", expiresIn: SIGNUP_SECONDS, audience: SIGNUP_AUDIENCE }),
    { ...signupCookieOptions(secureCookies), maxAge: SIGNUP_SECONDS * 1000 },
  );
}

function readTicket(token: unknown, secret: string): Ticket | null {
  if (typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"], audience: SIGNUP_AUDIENCE });
    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

// Trimmed, 1 to 100 characters, as the hostels.name check of migration 013.
const nameField = z
  .string()
  .trim()
  .min(1, "is required")
  .max(100, "can be at most 100 characters")
  .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed");

const signupSchema = z.object({
  ownerName: nameField,
  hostelName: nameField,
  slug: z.string().trim().toLowerCase(),
  acceptTerms: z.literal(true, "must be accepted"),
  termsVersion: z.string().max(40),
});

export type SignupRouteDeps = { db: Db; jwtSecret: string; secureCookies: boolean; signupsOpen: boolean };

export function signupRouter({ db, jwtSecret, secureCookies, signupsOpen }: SignupRouteDeps): Router {
  const router = Router();

  // A handful of hostels from one place in an hour is plenty; more looks like a script.
  // Only hostels made count: a form sent back with a mistake costs nothing.
  const perIp = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    skipFailedRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", "Too many sign-ups from here. Please try again later."),
  });

  const ticketOf = (req: { cookies?: Record<string, unknown> }) => readTicket(req.cookies?.[SIGNUP_COOKIE], jwtSecret);
  const closed = (res: Response) => sendError(res, 403, "signups_closed", "New hostels cannot sign up yet.");
  const notStarted = (res: Response) =>
    sendError(res, 401, "signup_not_started", "Start by choosing your Google account.");

  router.get("/signup", (req, res) => {
    if (!signupsOpen) return closed(res);
    const ticket = ticketOf(req);
    if (!ticket) return notStarted(res);
    res.set("Cache-Control", "no-store");
    res.json({ email: ticket.email, termsVersion: TERMS_VERSION });
  });

  router.get("/signup/slug", async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
    res.json(await checkSlug(db, slug));
  });

  router.post("/signup", perIp, async (req, res) => {
    if (!signupsOpen) return closed(res);
    const ticket = ticketOf(req);
    if (!ticket) return notStarted(res);
    const body = parseBody(signupSchema, req, res);
    if (!body) return;
    if (body.termsVersion !== TERMS_VERSION) {
      sendError(res, 409, "terms_changed", "The terms have changed since this page was opened. Reload it to read them.");
      return;
    }

    const { ownerId } = await createHostelWithOwner(db, {
      hostelName: body.hostelName,
      slug: body.slug,
      ownerName: body.ownerName,
      email: ticket.email,
      googleSub: ticket.sub,
      termsVersion: TERMS_VERSION,
    });
    res.clearCookie(SIGNUP_COOKIE, signupCookieOptions(secureCookies));
    res.cookie(SESSION_COOKIE, signSession({ userId: ownerId, role: "owner" }, jwtSecret), {
      ...sessionCookieOptions(secureCookies),
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.status(201).json({ user: { id: ownerId, name: body.ownerName, role: "owner", mustChangePassword: false } });
  });

  return router;
}

import { randomUUID } from "node:crypto";
import { Router, type CookieOptions } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { parseBody, sendError } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/password";
import { SESSION_TTL_SECONDS, signSession, type Role } from "../lib/token";
import { hostelWork, requireAuth, requireRole, SESSION_COOKIE, type AuthDeps } from "../middleware/auth";
import { activeHostelBySlug, slugSchema } from "../services/hostels";

export type AuthRouteDeps = AuthDeps & {
  // true in production (HTTPS): the browser then sends the cookie only over HTTPS.
  secureCookies: boolean;
};

const loginSchema = z.object({
  // The address of the sign-in page, /h/<slug>/login (phase 3a). Required since phase 6:
  // an email may belong to accounts in two hostels.
  hostel: z.string({ error: "open your hostel's own sign-in page, /h/<address>/login" }).pipe(slugSchema),
  email: z.string().trim().min(1, "is required").max(254),
  password: z.string().min(1, "is required").max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "is required").max(200),
  newPassword: z
    .string()
    .min(8, "must be at least 8 characters")
    // bcrypt reads only the first 72 bytes and silently ignores the rest.
    .refine((p) => Buffer.byteLength(p, "utf8") <= 72, "must be at most 72 bytes"),
});

type UserRow = {
  id: number;
  name: string;
  role: Role;
  must_change_password: boolean;
  // Missing only before migration 023 is applied.
  session_version?: number;
};

// The only user fields the auth endpoints ever send. Never the hash, never contact details.
function publicUser(row: UserRow) {
  return { id: row.id, name: row.name, role: row.role, mustChangePassword: row.must_change_password };
}

// A hash of a random password nobody knows, made once. Login compares against it when
// the email is unknown, so "no such email" takes as long as "wrong password" and the
// response time does not reveal who has an account.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomUUID()));

// Counts only failed attempts, so an owner who logs in normally is never locked out.
// Created per router, so every app (and every test) has its own counter.
function failedAttemptLimiter(message: string) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", message),
  });
}

// The session cookie's settings, shared with Google sign-in (routes/google.ts).
export function sessionCookieOptions(secureCookies: boolean): CookieOptions {
  return {
    httpOnly: true, // JavaScript in the page cannot read it, so an XSS bug cannot steal it
    sameSite: "lax", // not sent on cross-site POSTs
    secure: secureCookies,
    path: "/",
  };
}

const removePasswordSchema = z.object({
  currentPassword: z.string().min(1, "is required").max(200),
});

export function authRouter(deps: AuthRouteDeps): Router {
  const { db, jwtSecret, secureCookies } = deps;
  const inHostel = hostelWork(db);
  const router = Router();

  const cookieOptions = sessionCookieOptions(secureCookies);

  router.post(
    "/login",
    failedAttemptLimiter("Too many login attempts. Try again in 15 minutes."),
    async (req, res) => {
      const body = parseBody(loginSchema, req, res);
      if (!body) return;

      // The hostel at the page's address; an unknown or suspended one finds no account,
      // and gets the same answer, after the same work, as a wrong password.
      const hostelId = (await activeHostelBySlug(db, body.hostel))?.id;
      // Through auth_user_by_email (migration 014), which finds the account in one hostel
      // before anything else about the request is known.
      const { rows } =
        hostelId === undefined
          ? { rows: [] }
          : await db.query<UserRow & { password_hash: string | null; is_active: boolean; hostel_active: boolean }>(
              "SELECT * FROM auth_user_by_email($1, $2)",
              [hostelId, body.email],
            );
      const user = rows[0];
      const passwordOk = await verifyPassword(
        body.password,
        user?.password_hash ?? (await getDummyHash()),
      );
      // One answer for unknown email, wrong password, deactivated account and suspended
      // hostel alike.
      if (!user || !passwordOk || !user.is_active || !user.hostel_active) {
        sendError(res, 401, "invalid_credentials", "Email or password is incorrect.");
        return;
      }

      res.cookie(SESSION_COOKIE, signSession({ userId: user.id, role: user.role, sessionVersion: user.session_version ?? 0 }, jwtSecret), {
        ...cookieOptions,
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      res.json({ user: publicUser(user) });
    },
  );

  // Needs no valid session: clearing the cookie must work even after it has expired.
  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get("/me", requireAuth(deps, { allowTemporaryPassword: true }), async (req, res) => {
    const { rows } = await inHostel(req, (tx) =>
      tx.query<UserRow & { hostel_name: string; hostel_slug: string | null; google_linked: boolean; has_password: boolean }>(
        `SELECT u.id, u.name, u.role, u.must_change_password, h.name AS hostel_name, h.slug AS hostel_slug,
                u.google_sub IS NOT NULL AS google_linked, u.password_hash IS NOT NULL AS has_password
         FROM users u JOIN hostels h ON h.id = u.hostel_id
         WHERE u.id = $1 AND u.hostel_id = current_hostel_id()`,
        [req.user!.id],
      ),
    );
    const row = rows[0];
    // The hostel too: its name for the page, and its address for signing in again. And how
    // the account signs in (phase 3b), for the owner's settings; never the Google id itself.
    res.json({
      user: publicUser(row),
      hostel: { name: row.hostel_name, slug: row.hostel_slug },
      account: { googleLinked: row.google_linked, hasPassword: row.has_password },
    });
  });

  router.post(
    "/change-password",
    requireAuth(deps, { allowTemporaryPassword: true }),
    failedAttemptLimiter("Too many attempts. Try again in 15 minutes."),
    async (req, res) => {
      const body = parseBody(changePasswordSchema, req, res);
      if (!body) return;
      if (body.newPassword === body.currentPassword) {
        sendError(res, 400, "same_password", "Choose a new password, not the current one.");
        return;
      }

      const userId = req.user!.id;
      // Two short transactions, not one: no connection is held while bcrypt works.
      const current = await inHostel(req, (tx) =>
        tx.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1 AND hostel_id = current_hostel_id()", [userId]),
      );
      const currentHash = current.rows[0].password_hash;
      // An owner who signs in with Google only has no password to change.
      if (currentHash === null) {
        sendError(res, 400, "no_password", "This account signs in with Google and has no password.");
        return;
      }
      if (!(await verifyPassword(body.currentPassword, currentHash))) {
        // 400, not 401: the session is fine, only this form field is wrong.
        sendError(res, 400, "wrong_password", "Current password is incorrect.");
        return;
      }

      const newHash = await hashPassword(body.newPassword);
      const { rows } = await inHostel(req, (tx) =>
        tx.query<UserRow>(
          `UPDATE users SET password_hash = $1, must_change_password = false
           WHERE id = $2 AND hostel_id = current_hostel_id()
           RETURNING id, name, role, must_change_password, session_version`,
          [newHash, userId],
        ),
      );
      // The new hash raised session_version (migration 023), which ends every other
      // sign-in of this account; this one carries on with a session at the new number.
      res.cookie(
        SESSION_COOKIE,
        signSession({ userId, role: rows[0].role, sessionVersion: rows[0].session_version ?? 0 }, jwtSecret),
        { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 },
      );
      res.json({ user: publicUser(rows[0]) });
    },
  );

  // An owner whose Google account is linked may drop the password, and from then on signs
  // in with Google only (decided in phase 0). The current password confirms it is them.
  router.post(
    "/remove-password",
    requireAuth(deps),
    requireRole("owner"),
    failedAttemptLimiter("Too many attempts. Try again in 15 minutes."),
    async (req, res) => {
      const body = parseBody(removePasswordSchema, req, res);
      if (!body) return;
      const userId = req.user!.id;
      const { rows } = await inHostel(req, (tx) =>
        tx.query<{ password_hash: string | null; google_linked: boolean }>(
          `SELECT password_hash, google_sub IS NOT NULL AS google_linked
           FROM users WHERE id = $1 AND hostel_id = current_hostel_id()`,
          [userId],
        ),
      );
      const { password_hash: hash, google_linked: googleLinked } = rows[0];
      if (!googleLinked) {
        sendError(res, 400, "google_not_linked", "Link your Google account before removing the password.");
        return;
      }
      if (hash === null) {
        sendError(res, 400, "no_password", "This account already signs in with Google only.");
        return;
      }
      if (!(await verifyPassword(body.currentPassword, hash))) {
        sendError(res, 400, "wrong_password", "Current password is incorrect.");
        return;
      }
      // Only if Google is still linked (users_can_sign_in would refuse it otherwise).
      const removed = await inHostel(req, (tx) =>
        tx.query<{ session_version?: number }>(
          `UPDATE users SET password_hash = NULL
           WHERE id = $1 AND hostel_id = current_hostel_id() AND google_sub IS NOT NULL
           RETURNING session_version`,
          [userId],
        ),
      );
      // As after a password change: other sign-ins end (migration 023), this one carries on.
      if (removed.rows[0]) {
        res.cookie(
          SESSION_COOKIE,
          signSession({ userId, role: "owner", sessionVersion: removed.rows[0].session_version ?? 0 }, jwtSecret),
          { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 },
        );
      }
      res.status(204).end();
    },
  );

  return router;
}

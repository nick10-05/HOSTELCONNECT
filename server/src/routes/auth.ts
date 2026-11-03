import { randomUUID } from "node:crypto";
import { Router, type CookieOptions } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { parseBody, sendError } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/password";
import { SESSION_TTL_SECONDS, signSession, type Role } from "../lib/token";
import { requireAuth, SESSION_COOKIE, type AuthDeps } from "../middleware/auth";

export type AuthRouteDeps = AuthDeps & {
  // true in production (HTTPS): the browser then sends the cookie only over HTTPS.
  secureCookies: boolean;
};

const loginSchema = z.object({
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

export function authRouter(deps: AuthRouteDeps): Router {
  const { db, jwtSecret, secureCookies } = deps;
  const router = Router();

  const cookieOptions: CookieOptions = {
    httpOnly: true, // JavaScript in the page cannot read it, so an XSS bug cannot steal it
    sameSite: "lax", // not sent on cross-site POSTs
    secure: secureCookies,
    path: "/",
  };

  router.post(
    "/login",
    failedAttemptLimiter("Too many login attempts. Try again in 15 minutes."),
    async (req, res) => {
      const body = parseBody(loginSchema, req, res);
      if (!body) return;

      // lower(email) matches the unique index, so this is an index lookup.
      const { rows } = await db.query<UserRow & { password_hash: string; is_active: boolean }>(
        `SELECT id, name, role, must_change_password, password_hash, is_active
         FROM users WHERE lower(email) = lower($1)`,
        [body.email],
      );
      const user = rows[0];
      const passwordOk = await verifyPassword(
        body.password,
        user?.password_hash ?? (await getDummyHash()),
      );
      // One answer for unknown email, wrong password and deactivated account alike.
      if (!user || !passwordOk || !user.is_active) {
        sendError(res, 401, "invalid_credentials", "Email or password is incorrect.");
        return;
      }

      res.cookie(SESSION_COOKIE, signSession({ userId: user.id, role: user.role }, jwtSecret), {
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
    const { rows } = await db.query<UserRow>(
      "SELECT id, name, role, must_change_password FROM users WHERE id = $1",
      [req.user!.id],
    );
    res.json({ user: publicUser(rows[0]) });
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
      const current = await db.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId],
      );
      if (!(await verifyPassword(body.currentPassword, current.rows[0].password_hash))) {
        // 400, not 401: the session is fine, only this form field is wrong.
        sendError(res, 400, "wrong_password", "Current password is incorrect.");
        return;
      }

      const { rows } = await db.query<UserRow>(
        `UPDATE users SET password_hash = $1, must_change_password = false
         WHERE id = $2
         RETURNING id, name, role, must_change_password`,
        [await hashPassword(body.newPassword), userId],
      );
      res.json({ user: publicUser(rows[0]) });
    },
  );

  return router;
}

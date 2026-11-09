import { timingSafeEqual } from "node:crypto";
import { Router, type CookieOptions, type Response } from "express";
import jwt from "jsonwebtoken";
import { withHostel } from "../db";
import { sendError } from "../lib/http";
import { pkcePair, randomToken, type GoogleAuth } from "../lib/google";
import { SESSION_TTL_SECONDS, signSession, verifySession, type Role } from "../lib/token";
import { requireAuth, requireRole, SESSION_COOKIE, type AuthDeps } from "../middleware/auth";
import { sessionCookieOptions } from "./auth";

// Google sign-in for owners (multi-tenant phase 3b; src/lib/google.ts has the flow).
//
//   GET /api/auth/options          whether Google sign-in is on (the sign-in page asks)
//   GET /api/auth/google/start     signing in: off to Google
//   GET /api/auth/google/link      a signed-in owner links their Google account
//   GET /api/auth/google/callback  Google sends the browser back here
//
// What one sign-in needs to remember between start and callback (state, nonce, PKCE
// verifier, and for linking the owner) travels in a short-lived, signed, httpOnly cookie
// readable only on these paths. The callback always ends with a redirect to a page, which
// reads the outcome from ?google=…:
//   signing in, to /login:  no-account, inactive, cancelled, failed (or "/" when signed in)
//   linking, to /settings:  linked, taken, already-linked, cancelled, failed
export type GoogleRouteDeps = AuthDeps & {
  secureCookies: boolean;
  // Null when GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL are not set.
  google: GoogleAuth | null;
};

export const FLOW_COOKIE = "hc_google";
const FLOW_PATH = "/api/auth/google";
const FLOW_SECONDS = 10 * 60;
const FLOW_AUDIENCE = "hostelconnect-google-flow";
const UNIQUE_VIOLATION = "23505";

type Flow = { state: string; nonce: string; verifier: string; intent: "signin" | "link"; userId?: number };

function readFlow(token: unknown, secret: string): Flow | null {
  if (typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"], audience: FLOW_AUDIENCE });
    if (typeof payload === "string") return null;
    const { state, nonce, verifier, intent, userId } = payload as Partial<Flow>;
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return null;
    if (intent !== "signin" && intent !== "link") return null;
    if (intent === "link" && typeof userId !== "number") return null;
    return { state, nonce, verifier, intent, userId };
  } catch {
    return null;
  }
}

// Compared in constant time, though a state is only good for one sign-in anyway.
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function googleRouter(deps: GoogleRouteDeps): Router {
  const { db, jwtSecret, secureCookies, google } = deps;
  const router = Router();
  const flowCookie: CookieOptions = { httpOnly: true, sameSite: "lax", secure: secureCookies, path: FLOW_PATH };

  router.get("/options", (_req, res) => {
    res.json({ google: google !== null });
  });

  // Sends the browser to Google, remembering this sign-in in the flow cookie.
  function begin(res: Response, intent: Flow["intent"], userId?: number) {
    if (!google) {
      sendError(res, 404, "not_found", "Google sign-in is not set up.");
      return;
    }
    const { verifier, challenge } = pkcePair();
    const flow: Flow = { state: randomToken(), nonce: randomToken(), verifier, intent, ...(userId ? { userId } : {}) };
    res.cookie(FLOW_COOKIE, jwt.sign(flow, jwtSecret, { algorithm: "HS256", expiresIn: FLOW_SECONDS, audience: FLOW_AUDIENCE }), {
      ...flowCookie,
      maxAge: FLOW_SECONDS * 1000,
    });
    res.set("Cache-Control", "no-store");
    res.redirect(302, google.authUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: challenge }));
  }

  router.get("/google/start", (_req, res) => begin(res, "signin"));
  router.get("/google/link", requireAuth(deps), requireRole("owner"), (req, res) => begin(res, "link", req.user!.id));

  router.get("/google/callback", async (req, res) => {
    if (!google) {
      sendError(res, 404, "not_found", "Google sign-in is not set up.");
      return;
    }
    // Good for this one callback only.
    const flow = readFlow(req.cookies?.[FLOW_COOKIE], jwtSecret);
    res.clearCookie(FLOW_COOKIE, flowCookie);
    res.set("Cache-Control", "no-store");
    const back = flow?.intent === "link" ? "/settings" : "/login";
    const done = (outcome: string) => res.redirect(302, `${back}?google=${outcome}`);

    const { state, code, error } = req.query;
    if (!flow) return done("failed");
    // The owner pressed Cancel at Google, or Google refused.
    if (error !== undefined) return done(error === "access_denied" ? "cancelled" : "failed");
    if (typeof state !== "string" || !sameText(state, flow.state) || typeof code !== "string" || code === "") {
      return done("failed");
    }

    let sub: string;
    try {
      const idToken = await google.exchangeCode(code, flow.verifier);
      sub = (await google.verifyIdToken(idToken, flow.nonce)).sub;
    } catch (err) {
      // The reason (never a secret or a token) helps the operator; the owner sees "failed".
      console.warn("Google sign-in failed:", err instanceof Error ? err.message : err);
      return done("failed");
    }

    if (flow.intent === "signin") {
      const { rows } = await db.query<{ id: number; role: Role; is_active: boolean; hostel_active: boolean }>(
        "SELECT * FROM auth_owner_by_google_sub($1)",
        [sub],
      );
      const owner = rows[0];
      if (!owner) return done("no-account");
      if (!owner.is_active || !owner.hostel_active) return done("inactive");
      res.cookie(SESSION_COOKIE, signSession({ userId: owner.id, role: owner.role }, jwtSecret), {
        ...sessionCookieOptions(secureCookies),
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      return res.redirect(302, "/");
    }

    // Linking: only for the owner who started it, and still signed in as them.
    const session = verifySession(String(req.cookies?.[SESSION_COOKIE] ?? ""), jwtSecret);
    if (!session || session.userId !== flow.userId) return done("failed");
    const { rows: users } = await db.query<{ hostel_id: number; role: Role; is_active: boolean; hostel_active: boolean }>(
      "SELECT hostel_id, role, is_active, hostel_active FROM auth_user_by_id($1)",
      [flow.userId],
    );
    const user = users[0];
    if (!user || user.role !== "owner" || !user.is_active || !user.hostel_active) return done("failed");
    try {
      const { rowCount } = await withHostel(db, user.hostel_id, (tx) =>
        tx.query(
          `UPDATE users SET google_sub = $1
           WHERE id = $2 AND role = 'owner' AND google_sub IS NULL AND hostel_id = current_hostel_id()`,
          [sub, flow.userId],
        ),
      );
      return done(rowCount ? "linked" : "already-linked");
    } catch (err) {
      // That Google account already signs in to another HostelConnect account.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) return done("taken");
      throw err;
    }
  });

  return router;
}

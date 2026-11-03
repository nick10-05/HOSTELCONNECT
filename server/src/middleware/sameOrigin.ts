import type { RequestHandler } from "express";
import { sendError } from "../lib/http";

// Reading never changes anything, so only writes are checked.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF defence: refuse a write that a browser sent from another site's page.
//
// Browsers add an Origin header ("https://site.example") to every cross-origin
// request and to same-origin POST/PUT/PATCH/DELETE, and a page cannot forge it. So a
// write whose Origin names a different host than the one it was sent to came from
// someone else's page, riding on the owner's session cookie. The SameSite=Lax cookie
// already blocks most of these; this check is the second lock.
//
// - No Origin header: allowed. That is curl, scripts or supertest, which do not carry
//   a victim's cookie anyway.
// - Only the host (name and port) is compared, not http/https: in development the
//   browser talks to Vite, which forwards the original Host, and behind Render's proxy
//   req.host comes from X-Forwarded-Host once "trust proxy" is on. No list of allowed
//   origins to keep up to date.
// - Origin "null" (sandboxed iframes, some redirects) cannot be checked, so it is refused.
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (SAFE_METHODS.has(req.method) || origin === undefined) {
    next();
    return;
  }
  if (hostOf(origin) === req.host) {
    next();
    return;
  }
  sendError(res, 403, "cross_origin", "This request did not come from HostelConnect.");
};

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined; // "null" or garbage
  }
}

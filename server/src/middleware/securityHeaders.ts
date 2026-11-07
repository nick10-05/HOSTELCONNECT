import type { RequestHandler } from "express";

// Browser security headers on every response: the page, its files and the API.
// Tests: tests/securityHeaders.test.ts.

export type SecurityHeaderOptions = {
  // Production runs over HTTPS only (Render), so it may promise HTTPS (HSTS).
  production: boolean;
  // Where complaint photos are shown from: the Supabase project's origin, e.g.
  // "https://abcd.supabase.co" (config.SUPABASE_URL, already https with no path).
  // null or missing: photos are off, so no other origin is allowed.
  photoOrigin?: string | null;
  // CSP_REPORT_ONLY: send the policy as Content-Security-Policy-Report-Only, so browsers
  // only warn in the console instead of blocking. For trying a new policy safely.
  reportOnly?: boolean;
};

// ── CONTRACT ─────────────────────────────────────────────────────────────────────────
// contentSecurityPolicy(photoOrigin) returns the policy as one header value: directives
// in this order, separated by "; ", each name followed by its sources separated by a
// space:
//
//   default-src 'self'
//   script-src 'self'                  scripts only from this site; no inline, no eval
//   style-src 'self'                   the built CSS file (React style props still work)
//   img-src 'self' data: <photoOrigin> data: for the QR drawn in the browser; photoOrigin
//                                      only when given
//   font-src 'self'                    the self-hosted fonts
//   connect-src 'self'                 the API
//   object-src 'none'
//   base-uri 'none'
//   form-action 'self'
//   frame-ancestors 'none'             no other site may show HostelConnect in a frame
//   upgrade-insecure-requests          (no sources)
//
// securityHeaders(options) is middleware that sets on every response, then calls next():
//
//   Content-Security-Policy            the policy above (photoOrigin from options), or
//   Content-Security-Policy-Report-Only  instead, when reportOnly is true (never both)
//   X-Content-Type-Options             nosniff
//   Referrer-Policy                    same-origin
//   X-Frame-Options                    DENY   (older browsers; frame-ancestors for others)
//   Cross-Origin-Opener-Policy         same-origin
//   Permissions-Policy                 camera=(), microphone=(), geolocation=()
//   Strict-Transport-Security          max-age=31536000; includeSubDomains
//                                      ONLY when production is true
// ─────────────────────────────────────────────────────────────────────────────────────

export function contentSecurityPolicy(photoOrigin?: string | null): string {
  const images = ["'self'", "data:", ...(photoOrigin ? [photoOrigin] : [])];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", images],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["upgrade-insecure-requests", []],
  ];
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

export function securityHeaders({ production, photoOrigin, reportOnly = false }: SecurityHeaderOptions): RequestHandler {
  // The same for every response, so worked out once.
  const headers: Record<string, string> = {
    [reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"]:
      contentSecurityPolicy(photoOrigin),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  if (production) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";

  return (_req, res, next) => {
    res.set(headers);
    next();
  };
}

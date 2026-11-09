import { createHash, createPublicKey, randomBytes, type JsonWebKey } from "node:crypto";
import jwt from "jsonwebtoken";

// Google sign-in for owners (multi-tenant phase 3b): OpenID Connect's authorization code
// flow, run on the server, with PKCE. The browser goes to Google and comes back with a
// one-time code; the server trades the code, with its client secret and the PKCE verifier,
// for an ID token, and checks that token itself:
//   - signed by Google (RS256, one of Google's published keys);
//   - issued by Google, for this app (audience = our client id), and not expired;
//   - carrying the nonce this sign-in started with (no replayed token);
//   - for an email Google has verified.
// The account is then found by Google's `sub`, the stable id of the Google account; the
// email is never used to find anyone (an email can change hands).

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: [string, string] = ["accounts.google.com", "https://accounts.google.com"];

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  // Where Google sends the browser back: <PUBLIC_URL>/api/auth/google/callback, exactly as
  // registered with the OAuth client.
  redirectUri: string;
};

export type GoogleIdentity = { sub: string; email: string };

// What the routes need from Google; tests pass a fake.
export interface GoogleAuth {
  authUrl(params: { state: string; nonce: string; codeChallenge: string }): string;
  // The ID token for this one-time code. Throws when Google refuses it.
  exchangeCode(code: string, codeVerifier: string): Promise<string>;
  // The checked identity, or throws (GoogleTokenError) when any check fails.
  verifyIdToken(idToken: string, nonce: string): Promise<GoogleIdentity>;
}

export class GoogleTokenError extends Error {}

// A random value that is safe in a URL: state, nonce and the PKCE verifier.
export const randomToken = () => randomBytes(32).toString("base64url");

// PKCE (RFC 7636, S256): the challenge goes to Google at the start, the verifier only
// with the code at the end, so a stolen code is useless without it.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthUrl(
  config: Pick<GoogleConfig, "clientId" | "redirectUri">,
  { state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Always ask which account: an owner may be signed in to several.
    prompt: "select_account",
  }).toString();
  return url.toString();
}

type Key = JsonWebKey & { kid?: string };

export class UnknownKeyError extends GoogleTokenError {}

// Checks an ID token against Google's keys `keys` (the JWKS at KEYS_URL). Pure: no
// network. `now` is in seconds.
export function verifyGoogleIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; keys: Key[]; now?: number },
): GoogleIdentity {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded.payload === "string") throw new GoogleTokenError("not a token");
  if (decoded.header.alg !== "RS256") throw new GoogleTokenError("not signed with RS256");
  const jwk = opts.keys.find((k) => k.kid !== undefined && k.kid === decoded.header.kid);
  if (!jwk) throw new UnknownKeyError("signed with a key Google does not publish");

  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(idToken, createPublicKey({ key: jwk, format: "jwk" }), {
      algorithms: ["RS256"],
      audience: opts.clientId,
      issuer: ISSUERS,
      clockTimestamp: opts.now,
    });
    if (typeof verified === "string") throw new GoogleTokenError("not a token");
    payload = verified;
  } catch (err) {
    if (err instanceof GoogleTokenError) throw err;
    throw new GoogleTokenError(err instanceof Error ? err.message : "invalid token");
  }
  if (payload.nonce !== opts.nonce) throw new GoogleTokenError("nonce does not match");
  if (payload.email_verified !== true) throw new GoogleTokenError("email not verified by Google");
  if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.email !== "string") {
    throw new GoogleTokenError("no account id or email");
  }
  return { sub: payload.sub, email: payload.email };
}

// How long Google says its keys may be kept (Cache-Control max-age), else an hour.
function maxAgeSeconds(cacheControl: string | null): number {
  const match = cacheControl?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) : 3600;
}

// Google sign-in from the settings, or null when they are not set (config.ts checks that
// all three come together).
export function googleFromConfig(config: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLIC_URL?: string;
}): GoogleAuth | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, PUBLIC_URL: publicUrl } = config;
  if (!clientId || !clientSecret || !publicUrl) return null;
  return googleAuth({ clientId, clientSecret, redirectUri: `${publicUrl}/api/auth/google/callback` });
}

// The real thing, talking to Google. Keys are cached as long as Google allows and fetched
// again once when a token names a key not in the cache (Google rotates them).
export function googleAuth(
  config: GoogleConfig,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): GoogleAuth {
  const fetchFn = deps.fetch ?? fetch;
  const nowMs = deps.now ?? Date.now;
  let cached: { keys: Key[]; until: number } | null = null;

  async function keys(force: boolean): Promise<Key[]> {
    if (!force && cached && cached.until > nowMs()) return cached.keys;
    const res = await fetchFn(KEYS_URL);
    if (!res.ok) throw new Error(`Google keys answered ${res.status}`);
    const body = (await res.json()) as { keys?: Key[] };
    cached = { keys: body.keys ?? [], until: nowMs() + maxAgeSeconds(res.headers.get("cache-control")) * 1000 };
    return cached.keys;
  }

  return {
    authUrl: (params) => buildAuthUrl(config, params),

    async exchangeCode(code, codeVerifier) {
      const res = await fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          code_verifier: codeVerifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      // Google's error body names the problem, never a secret, but it is not passed on.
      if (!res.ok) throw new GoogleTokenError(`Google refused the code (${res.status})`);
      const body = (await res.json()) as { id_token?: unknown };
      if (typeof body.id_token !== "string") throw new GoogleTokenError("no ID token from Google");
      return body.id_token;
    },

    async verifyIdToken(idToken, nonce) {
      const check = (list: Key[]) =>
        verifyGoogleIdToken(idToken, { clientId: config.clientId, nonce, keys: list, now: Math.floor(nowMs() / 1000) });
      try {
        return check(await keys(false));
      } catch (err) {
        if (!(err instanceof UnknownKeyError)) throw err;
        return check(await keys(true));
      }
    },
  };
}

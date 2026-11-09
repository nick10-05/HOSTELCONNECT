import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_URL,
  buildAuthUrl,
  googleAuth,
  GoogleTokenError,
  KEYS_URL,
  pkcePair,
  TOKEN_URL,
  verifyGoogleIdToken,
} from "../src/lib/google";

// src/lib/google.ts (multi-tenant phase 3b). A key pair made here stands in for Google's:
// tokens are signed with its private half, and its public half is "published".
const CLIENT_ID = "1234-abc.apps.googleusercontent.com";
const NONCE = "the-nonce-of-this-sign-in";
const NOW = 1_800_000_000; // seconds

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}
const google = keyPair("google-key-1");
const stranger = keyPair("stranger-key");

const claims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "110169484474386276334",
  email: "owner@gmail.com",
  email_verified: true,
  nonce: NONCE,
  iat: NOW - 10,
  exp: NOW + 3600,
  ...over,
});

const sign = (payload: object, key: KeyObject = google.privateKey, kid = google.kid) =>
  jwt.sign(payload, key, { algorithm: "RS256", keyid: kid });

const verify = (token: string, keys = [google.jwk]) =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, nonce: NONCE, keys, now: NOW });

describe("verifyGoogleIdToken", () => {
  it("accepts Google's token for this app and gives the account id and email", () => {
    expect(verify(sign(claims()))).toEqual({ sub: "110169484474386276334", email: "owner@gmail.com" });
    // Google also issues with the bare host name.
    expect(verify(sign(claims({ iss: "accounts.google.com" }))).sub).toBe("110169484474386276334");
  });

  it.each([
    ["another app's token", claims({ aud: "someone-else.apps.googleusercontent.com" })],
    ["another issuer", claims({ iss: "https://evil.example.com" })],
    ["an expired token", claims({ exp: NOW - 1 })],
    ["another sign-in's nonce", claims({ nonce: "an-old-nonce" })],
    ["an email Google has not verified", claims({ email_verified: false })],
    ["no email_verified at all", claims({ email_verified: undefined })],
    ["no account id", claims({ sub: undefined })],
  ])("refuses %s", (_name, payload) => {
    expect(() => verify(sign(payload))).toThrow(GoogleTokenError);
  });

  it("refuses a token signed with a key Google does not publish, or forged with another key", () => {
    expect(() => verify(sign(claims(), stranger.privateKey, stranger.kid))).toThrow(GoogleTokenError);
    // Claims Google's key id, signed with another key.
    expect(() => verify(sign(claims(), stranger.privateKey, google.kid))).toThrow(GoogleTokenError);
  });

  it("refuses unsigned and HS256 tokens", () => {
    const none = jwt.sign(claims(), "", { algorithm: "none" });
    expect(() => verify(none)).toThrow(GoogleTokenError);
    const hs = jwt.sign(claims(), "shared-secret", { algorithm: "HS256", keyid: google.kid });
    expect(() => verify(hs)).toThrow(GoogleTokenError);
    expect(() => verify("not-a-token")).toThrow(GoogleTokenError);
  });
});

describe("the start of a sign-in", () => {
  it("makes a PKCE pair whose challenge is the verifier's SHA-256", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it("sends the browser to Google with the code flow, PKCE, state and nonce", () => {
    const url = new URL(
      buildAuthUrl(
        { clientId: CLIENT_ID, redirectUri: "https://app.example/api/auth/google/callback" },
        { state: "s1", nonce: "n1", codeChallenge: "c1" },
      ),
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: "https://app.example/api/auth/google/callback",
      response_type: "code",
      scope: "openid email",
      state: "s1",
      nonce: "n1",
      code_challenge: "c1",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });
});

describe("googleAuth", () => {
  const config = { clientId: CLIENT_ID, clientSecret: "the-client-secret", redirectUri: "https://app.example/cb" };
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });

  it("trades the code, with the secret and the PKCE verifier, for the ID token", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ id_token: "the-id-token" }));
    const auth = googleAuth(config, { fetch: fetch as typeof globalThis.fetch });
    expect(await auth.exchangeCode("the-code", "the-verifier")).toBe("the-id-token");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      code: "the-code",
      code_verifier: "the-verifier",
      client_id: CLIENT_ID,
      client_secret: "the-client-secret",
      redirect_uri: "https://app.example/cb",
      grant_type: "authorization_code",
    });
  });

  it("fails when Google refuses the code", async () => {
    const fetch = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const auth = googleAuth(config, { fetch: fetch as typeof globalThis.fetch });
    await expect(auth.exchangeCode("used-code", "v")).rejects.toThrow(GoogleTokenError);
  });

  it("keeps Google's keys as long as Google allows, and fetches again for a new key", async () => {
    let now = NOW * 1000;
    let published = [google.jwk];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe(KEYS_URL);
      return json({ keys: published }, { "Cache-Control": "public, max-age=600" });
    });
    const auth = googleAuth(config, { fetch: fetch as typeof globalThis.fetch, now: () => now });

    await auth.verifyIdToken(sign(claims()), NONCE);
    await auth.verifyIdToken(sign(claims()), NONCE);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Google rotates to a new key: a token with its id makes one more fetch.
    const next = keyPair("google-key-2");
    published = [google.jwk, next.jwk];
    expect((await auth.verifyIdToken(sign(claims(), next.privateKey, next.kid), NONCE)).sub).toBe("110169484474386276334");
    expect(fetch).toHaveBeenCalledTimes(2);
    // After max-age the keys are fetched again.
    now += 601_000;
    await expect(auth.verifyIdToken(sign(claims({ exp: NOW + 3600 })), NONCE)).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

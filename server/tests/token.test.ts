import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TTL_SECONDS, signSession, verifySession } from "../src/lib/token";

const SECRET = "test-secret-that-is-at-least-32-characters";
const claims = { userId: 42, role: "student" as const };

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session tokens", () => {
  it("lasts 7 days", () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("round-trips the user id and role", () => {
    expect(verifySession(signSession(claims, SECRET), SECRET)).toEqual({ ...claims, sessionVersion: 0 });
  });

  it("carries only the id, role, session version and timestamps, no personal data", () => {
    const keys = Object.keys(payloadOf(signSession(claims, SECRET))).sort();
    expect(keys).toEqual(["exp", "iat", "role", "sv", "userId"]);
  });

  it("rejects a token signed with another secret", () => {
    const token = signSession(claims, "another-secret-that-is-at-least-32-chars");
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a token whose payload was edited", () => {
    const [header, , signature] = signSession(claims, SECRET).split(".");
    const forged = [header, base64url({ ...claims, role: "owner" }), signature].join(".");
    expect(verifySession(forged, SECRET)).toBeNull();
  });

  it('rejects an unsigned token (alg "none")', () => {
    const unsigned = [
      base64url({ alg: "none", typ: "JWT" }),
      base64url({ userId: 1, role: "owner", iat: 0, exp: 4_102_444_800 }),
      "",
    ].join(".");
    expect(verifySession(unsigned, SECRET)).toBeNull();
  });

  it("rejects garbage without throwing", () => {
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession("not.a.token", SECRET)).toBeNull();
  });

  it("is valid just before 7 days and rejected after", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
    const token = signSession(claims, SECRET);

    vi.setSystemTime(new Date("2026-11-10T09:59:00Z"));
    expect(verifySession(token, SECRET)).toEqual({ ...claims, sessionVersion: 0 });

    vi.setSystemTime(new Date("2026-11-10T10:01:00Z"));
    expect(verifySession(token, SECRET)).toBeNull();
  });
});

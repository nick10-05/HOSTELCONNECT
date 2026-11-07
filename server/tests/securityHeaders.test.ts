import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPool } from "../src/db";
import { contentSecurityPolicy, securityHeaders } from "../src/middleware/securityHeaders";

const PHOTOS = "https://abcd.supabase.co";

// "a b; c d" -> { a: ["b"], c: ["d"] }, keeping the order of the names.
function directives(policy: string) {
  return policy.split("; ").map((part) => {
    const [name, ...sources] = part.trim().split(" ");
    return [name, sources] as const;
  });
}
const asMap = (policy: string) => new Map(directives(policy));

describe("contentSecurityPolicy", () => {
  it("has exactly the agreed directives, in order", () => {
    expect(directives(contentSecurityPolicy(PHOTOS)).map(([name]) => name)).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "upgrade-insecure-requests",
    ]);
  });

  it("allows scripts, styles, fonts and API calls from this site only", () => {
    const policy = asMap(contentSecurityPolicy(PHOTOS));
    for (const name of ["default-src", "script-src", "style-src", "font-src", "connect-src", "form-action"]) {
      expect(policy.get(name), name).toEqual(["'self'"]);
    }
  });

  it("never allows inline scripts or eval", () => {
    const text = contentSecurityPolicy(PHOTOS);
    expect(text).not.toContain("unsafe-inline");
    expect(text).not.toContain("unsafe-eval");
    expect(text).not.toMatch(/\*|https:(?!\/\/)/); // no wildcards, no bare https:
  });

  it("shows images from this site, data: (the drawn QR) and the photo origin", () => {
    expect(asMap(contentSecurityPolicy(PHOTOS)).get("img-src")).toEqual(["'self'", "data:", PHOTOS]);
  });

  it("allows no other image origin when photos are off", () => {
    expect(asMap(contentSecurityPolicy(null)).get("img-src")).toEqual(["'self'", "data:"]);
    expect(asMap(contentSecurityPolicy(undefined)).get("img-src")).toEqual(["'self'", "data:"]);
  });

  it("blocks plugins, <base> tricks and framing by other sites", () => {
    const policy = asMap(contentSecurityPolicy(PHOTOS));
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("upgrade-insecure-requests")).toEqual([]);
  });
});

function appWith(options: Parameters<typeof securityHeaders>[0]) {
  const app = express();
  app.use(securityHeaders(options));
  app.get("/", (_req, res) => {
    res.send("ok");
  });
  return app;
}

describe("securityHeaders", () => {
  it("sets the policy and the other headers, then lets the request through", async () => {
    const res = await request(appWith({ production: true, photoOrigin: PHOTOS })).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
    expect(res.headers["content-security-policy"]).toBe(contentSecurityPolicy(PHOTOS));
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("promises HTTPS only in production", async () => {
    const res = await request(appWith({ production: false })).get("/");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBe(contentSecurityPolicy(null));
  });

  it("in report-only mode sends the same policy under the report-only name instead", async () => {
    const res = await request(appWith({ production: true, photoOrigin: PHOTOS, reportOnly: true })).get("/");
    expect(res.headers["content-security-policy-report-only"]).toBe(contentSecurityPolicy(PHOTOS));
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

// Through the real app: the page, its files, the API and error answers all carry them.
describe("the app sends the security headers", () => {
  const SECRET = "test-secret-that-is-at-least-32-characters";
  const db = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
  const clientDir = mkdtempSync(path.join(tmpdir(), "hc-client-"));
  mkdirSync(path.join(clientDir, "assets"));
  writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>HostelConnect</title>");
  writeFileSync(path.join(clientDir, "assets", "index-Bx12ab.js"), "console.log(1)");
  writeFileSync(path.join(clientDir, "theme-init.js"), "void 0");

  afterAll(async () => {
    await db.end();
    rmSync(clientDir, { recursive: true, force: true });
  });

  const app = createApp({ db, jwtSecret: SECRET, clientDir, production: true, photoOrigin: PHOTOS });

  it.each([
    ["the page", "/"],
    ["a deep link", "/students/12"],
    ["a hashed asset", "/assets/index-Bx12ab.js"],
    ["the theme script", "/theme-init.js"],
    ["an unknown API path", "/api/nothing-here"],
    ["a missing asset", "/assets/index-old.js"],
  ])("on %s", async (_name, url) => {
    const res = await request(app).get(url);
    expect(res.headers["content-security-policy"]).toBe(contentSecurityPolicy(PHOTOS));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("uses report-only when asked", async () => {
    const trial = createApp({ db, jwtSecret: SECRET, clientDir, production: true, cspReportOnly: true });
    const res = await request(trial).get("/");
    expect(res.headers["content-security-policy-report-only"]).toBe(contentSecurityPolicy(null));
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

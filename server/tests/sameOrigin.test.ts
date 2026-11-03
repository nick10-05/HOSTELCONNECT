import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPool } from "../src/db";

// The Origin check through the real app. POST /api/auth/logout needs no database and
// answers 204, so it shows whether a write got past the check.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
afterAll(() => db.end());

const app = createApp({ db, jwtSecret: SECRET });
const prodApp = createApp({ db, jwtSecret: SECRET, production: true });

const logout = (origin?: string) => {
  const req = request(app).post("/api/auth/logout").set("Host", "hostel.example");
  return origin === undefined ? req : req.set("Origin", origin);
};

describe("requireSameOrigin", () => {
  it("allows a write from the app's own page", async () => {
    expect((await logout("https://hostel.example")).status).toBe(204);
  });

  it("allows a write with no Origin header (not a browser)", async () => {
    expect((await logout()).status).toBe(204);
  });

  it("refuses a write from another site", async () => {
    const res = await logout("https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("cross_origin");
  });

  it("refuses look-alike hosts and other ports", async () => {
    for (const origin of [
      "https://hostel.example.evil.example",
      "https://evilhostel.example",
      "https://hostel.example:8443",
    ]) {
      expect((await logout(origin)).status, origin).toBe(403);
    }
  });

  it('refuses Origin "null" and malformed values', async () => {
    expect((await logout("null")).status).toBe(403);
    expect((await logout("not a url")).status).toBe(403);
  });

  it("checks login too, so another site cannot log the owner into its account", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Host", "hostel.example")
      .set("Origin", "https://evil.example")
      .send({ email: "a@b.c", password: "x" });
    expect(res.status).toBe(403);
  });

  it("lets reads through whatever their Origin", async () => {
    const res = await request(app)
      .get("/api/no-such-endpoint")
      .set("Host", "hostel.example")
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(404);
  });

  it("in production, compares against the public host the proxy forwards", async () => {
    const viaProxy = (origin: string) =>
      request(prodApp)
        .post("/api/auth/logout")
        .set("Host", "10.0.0.5:10000")
        .set("X-Forwarded-Host", "hostel.example")
        .set("Origin", origin);
    expect((await viaProxy("https://hostel.example")).status).toBe(204);
    expect((await viaProxy("https://evil.example")).status).toBe(403);
  });

  it("outside production, ignores X-Forwarded-Host (no proxy to trust)", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Host", "hostel.example")
      .set("X-Forwarded-Host", "evil.example")
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
  });
});

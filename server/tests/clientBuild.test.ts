import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPool } from "../src/db";

// Express serving the built React app (one origin for page and API in production).
// A tiny fake build in a temp folder stands in for client/dist.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = createPool("postgres://nobody:nothing@127.0.0.1:1/none");

const clientDir = mkdtempSync(path.join(tmpdir(), "hc-client-"));
mkdirSync(path.join(clientDir, "assets"));
writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>HostelConnect</title>");
writeFileSync(path.join(clientDir, "assets", "index-Bx12ab.js"), "console.log(1)");
writeFileSync(path.join(clientDir, "favicon.svg"), "<svg/>");

afterAll(async () => {
  await db.end();
  rmSync(clientDir, { recursive: true, force: true });
});

const app = createApp({ db, jwtSecret: SECRET, clientDir });

describe("serving the client build", () => {
  it("serves index.html at / and tells the browser to revalidate it", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain("HostelConnect");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it.each(["/students/12", "/h/sns-hostel/login", "/terms"])(
    "serves index.html for the app's other pages, so reloading %s works",
    async (page) => {
      const res = await request(app).get(page);
      expect(res.status).toBe(200);
      expect(res.text).toContain("HostelConnect");
    },
  );

  it.each(["/paypal/signin", "/office365/verify-account", "/wp-login.php"])(
    "answers 404 at %s, an address the app has no page for, with the page that says so",
    async (page) => {
      const res = await request(app).get(page);
      expect(res.status).toBe(404);
      expect(res.type).toBe("text/html");
      expect(res.text).toContain("HostelConnect");
      expect(res.headers["cache-control"]).toBe("no-cache");
    },
  );

  it("caches hashed assets for a year", async () => {
    const res = await request(app).get("/assets/index-Bx12ab.js");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("answers 404 for a missing asset instead of sending the page", async () => {
    const res = await request(app).get("/assets/index-old.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("HostelConnect");
  });

  it("serves other files at the root of the build", async () => {
    const res = await request(app).get("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/svg+xml");
  });

  it("keeps unknown /api paths as JSON 404s", async () => {
    const res = await request(app).get("/api/no-such-endpoint");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("serves no pages when no build folder is given (development uses Vite)", async () => {
    const res = await request(createApp({ db, jwtSecret: SECRET })).get("/");
    expect(res.status).toBe(404);
  });

  it("refuses to start when the build folder has no index.html", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "hc-empty-"));
    try {
      expect(() => createApp({ db, jwtSecret: SECRET, clientDir: empty })).toThrow(/index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

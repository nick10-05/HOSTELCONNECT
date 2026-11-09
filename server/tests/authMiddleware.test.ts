import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { signSession, type SessionClaims } from "../src/lib/token";
import { requireAuth, requireRole, SESSION_COOKIE } from "../src/middleware/auth";
import { Client } from "pg";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Uses your signSession, so finish token.ts first. Users are committed to the test
// database so the middleware's own connection can see them.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

// A tiny app with one route per guard combination.
const app = express();
app.use(cookieParser());
const deps = { db, jwtSecret: SECRET };
app.get("/any", requireAuth(deps), (req, res) => {
  res.json(req.user);
});
app.get("/temp-ok", requireAuth(deps, { allowTemporaryPassword: true }), (req, res) => {
  res.json(req.user);
});
app.get("/owner", requireAuth(deps), requireRole("owner"), (_req, res) => {
  res.json({ ok: true });
});
app.get("/role-without-auth", requireRole("owner"), (_req, res) => {
  res.json({ ok: true });
});

const asUser = (path: string, token: string) =>
  request(app).get(path).set("Cookie", `${SESSION_COOKIE}=${token}`);
const tokenFor = (userId: number, role: SessionClaims["role"]) =>
  signSession({ userId, role }, SECRET);

function expectError(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe("requireAuth", () => {
  it("lets an active user through and sets req.user from the database", async () => {
    const id = await insertStudent(db);
    const res = await asUser("/any", tokenFor(id, "student"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, hostelId: 1, role: "student", mustChangePassword: false });
  });

  it("refuses a request without a session cookie", async () => {
    expectError(await request(app).get("/any"), 401, "unauthenticated");
  });

  it("reads the session only from the cookie, not an Authorization header", async () => {
    const id = await insertStudent(db);
    const res = await request(app)
      .get("/any")
      .set("Authorization", `Bearer ${tokenFor(id, "student")}`);
    expectError(res, 401, "unauthenticated");
  });

  it("refuses a malformed token and one signed with another secret", async () => {
    const id = await insertStudent(db);
    expectError(await asUser("/any", "garbage"), 401, "unauthenticated");
    const foreign = signSession({ userId: id, role: "student" }, "x".repeat(40));
    expectError(await asUser("/any", foreign), 401, "unauthenticated");
  });

  it("refuses an expired token", async () => {
    const id = await insertStudent(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const old = tokenFor(id, "student");
    vi.useRealTimers();
    expectError(await asUser("/any", old), 401, "unauthenticated");
  });

  it("refuses a token for a user that does not exist", async () => {
    expectError(await asUser("/any", tokenFor(2_000_000_000, "owner")), 401, "unauthenticated");
  });

  it("refuses a deactivated user even with a valid token", async () => {
    const id = await insertStudent(db, { isActive: false });
    expectError(await asUser("/any", tokenFor(id, "student")), 401, "unauthenticated");
  });

  // Multi-tenant phase 2a: the hostel comes from the user's row too, never from the token.
  it("sets req.user.hostelId from the database, for a user of any hostel", async () => {
    const { hostelId, userId } = await committedOwnerOfNewHostel("active");
    const res = await asUser("/any", tokenFor(userId, "owner"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, hostelId, role: "owner", mustChangePassword: false });
  });

  it("refuses everyone of a suspended hostel, even with a valid token", async () => {
    const { userId } = await committedOwnerOfNewHostel("suspended");
    expectError(await asUser("/any", tokenFor(userId, "owner")), 401, "unauthenticated");
    expectError(await asUser("/temp-ok", tokenFor(userId, "owner")), 401, "unauthenticated");
  });

  it("takes the role from the database, not from the token", async () => {
    const id = await insertStudent(db);
    const claimsOwner = tokenFor(id, "owner");
    expect((await asUser("/any", claimsOwner)).body.role).toBe("student");
    expectError(await asUser("/owner", claimsOwner), 403, "forbidden");
  });

  describe("temporary password", () => {
    it("blocks every ordinary route", async () => {
      const id = await insertStudent(db, { mustChangePassword: true });
      expectError(await asUser("/any", tokenFor(id, "student")), 403, "password_change_required");
    });

    it("also blocks the owner before the role check", async () => {
      const id = await insertOwner(db, { mustChangePassword: true });
      expectError(await asUser("/owner", tokenFor(id, "owner")), 403, "password_change_required");
    });

    it("allows routes that opt in, and says a change is pending", async () => {
      const id = await insertStudent(db, { mustChangePassword: true });
      const res = await asUser("/temp-ok", tokenFor(id, "student"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id, hostelId: 1, role: "student", mustChangePassword: true });
    });

    it("still refuses a deactivated user on those routes", async () => {
      const id = await insertStudent(db, { mustChangePassword: true, isActive: false });
      expectError(await asUser("/temp-ok", tokenFor(id, "student")), 401, "unauthenticated");
    });
  });
});

describe("requireRole", () => {
  it("lets the owner through", async () => {
    const id = await insertOwner(db);
    const res = await asUser("/owner", tokenFor(id, "owner"));
    expect(res.status).toBe(200);
  });

  it("refuses a student on an owner route", async () => {
    const id = await insertStudent(db);
    expectError(await asUser("/owner", tokenFor(id, "student")), 403, "forbidden");
  });

  it("refuses when requireAuth did not run first", async () => {
    expectError(await request(app).get("/role-without-auth"), 401, "unauthenticated");
  });
});

// A hostel with one owner, committed so the middleware's own connection sees them. Only
// the platform admin may suspend a hostel, so this uses the admin credential on the test
// database. The rows stay, like every committed row of this file; the test database is
// recreated on each run.
async function committedOwnerOfNewHostel(status: "active" | "suspended") {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    const hostelId = (
      await admin.query<{ id: number }>("INSERT INTO hostels (name, status) VALUES ('Middleware Hostel', $1) RETURNING id", [
        status,
      ])
    ).rows[0].id;
    const userId = (
      await admin.query<{ id: number }>(
        `INSERT INTO users (hostel_id, role, name, email, password_hash, must_change_password)
         VALUES ($1, 'owner', 'Other Owner', $2, 'x', false) RETURNING id`,
        [hostelId, `middleware-${hostelId}@test.local`],
      )
    ).rows[0].id;
    return { hostelId: Number(hostelId), userId: Number(userId) };
  } finally {
    await admin.end();
  }
}

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// The auth endpoints through the real app and the test database.
// Hashing at cost 12 is slow, so one hash is made up front and shared.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

const newApp = (production = false) => createApp({ db, jwtSecret: SECRET, production });

async function emailOf(id: number): Promise<string> {
  const { rows } = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
  return rows[0].email;
}

function sessionCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

describe("POST /api/auth/login", { timeout: 30_000 }, () => {
  it("logs in, sets a safe session cookie and returns the user without secrets", async () => {
    const id = await insertOwner(db, { passwordHash });
    const res = await request(newApp())
      .post("/api/auth/login")
      .send({ email: await emailOf(id), password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id, name: "Test Owner", role: "owner", mustChangePassword: false },
    });
    expect(JSON.stringify(res.body)).not.toContain("$2");

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=604800/);
    // Plain HTTP in development, so not Secure there.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure in production", async () => {
    const id = await insertOwner(db, { passwordHash });
    const res = await request(newApp(true))
      .post("/api/auth/login")
      .send({ email: await emailOf(id), password: PASSWORD });
    expect(sessionCookie(res)).toMatch(/Secure/i);
  });

  it("ignores case and surrounding spaces in the email", async () => {
    const id = await insertOwner(db, { passwordHash });
    const res = await request(newApp())
      .post("/api/auth/login")
      .send({ email: `  ${(await emailOf(id)).toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("gives the same answer for a wrong password, an unknown email and a deactivated account", async () => {
    const active = await insertStudent(db, { passwordHash });
    const inactive = await insertStudent(db, { passwordHash, isActive: false });
    const app = newApp();
    const attempts = [
      { email: await emailOf(active), password: "wrong-password" },
      { email: `nobody-${randomUUID()}@test.local`, password: PASSWORD },
      { email: await emailOf(inactive), password: PASSWORD },
    ];
    for (const attempt of attempts) {
      const res = await request(app).post("/api/auth/login").send(attempt);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: "invalid_credentials", message: "Email or password is incorrect." },
      });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it("rejects a missing password with 400", async () => {
    const res = await request(newApp()).post("/api/auth/login").send({ email: "a@b.c" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
  });

  it("rejects broken JSON with 400", async () => {
    const res = await request(newApp())
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("blocks an IP after 10 failed attempts, even with the right password", async () => {
    const id = await insertStudent(db, { passwordHash });
    const email = await emailOf(id);
    const app = newApp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password: "wrong" });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });

  it("does not count successful logins towards the limit", async () => {
    const id = await insertOwner(db, { passwordHash });
    const email = await emailOf(id);
    const app = newApp();
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
    }
  });
});

describe("session endpoints", { timeout: 30_000 }, () => {
  it("me answers 401 without a session", async () => {
    const res = await request(newApp()).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("me returns the logged-in user, and logout ends the session", async () => {
    const id = await insertOwner(db, { passwordHash });
    const agent = request.agent(newApp());
    await agent.post("/api/auth/login").send({ email: await emailOf(id), password: PASSWORD });

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id, role: "owner" });

    const out = await agent.post("/api/auth/logout");
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("logout works without a session", async () => {
    expect((await request(newApp()).post("/api/auth/logout")).status).toBe(204);
  });

  it("answers 404 in the API error shape for an unknown endpoint", async () => {
    const res = await request(newApp()).get("/api/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("POST /api/auth/change-password", { timeout: 30_000 }, () => {
  async function loggedInWithTemporaryPassword() {
    const id = await insertStudent(db, { passwordHash, mustChangePassword: true });
    const email = await emailOf(id);
    const agent = request.agent(newApp());
    const login = await agent.post("/api/auth/login").send({ email, password: PASSWORD });
    expect(login.body.user.mustChangePassword).toBe(true);
    return { id, email, agent };
  }

  it("replaces a temporary password and clears the flag", async () => {
    const { email, agent } = await loggedInWithTemporaryPassword();
    expect((await agent.get("/api/auth/me")).status).toBe(200);

    const res = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-secret" });
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);

    const app = newApp();
    const oldLogin = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "a-brand-new-secret" });
    expect(newLogin.status).toBe(200);
  });

  it("refuses a wrong current password without logging the user out", async () => {
    const { agent } = await loggedInWithTemporaryPassword();
    const res = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: "not-it", newPassword: "a-brand-new-secret" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_password");
  });

  it("refuses a new password that is too short, too long or unchanged", async () => {
    const { agent } = await loggedInWithTemporaryPassword();
    const tooShort = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: "short" });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.message).toMatch(/at least 8/);

    // 25 three-byte characters = 75 bytes, past bcrypt's 72-byte limit.
    const tooLong = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: "€".repeat(25) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.message).toMatch(/72 bytes/);

    const same = await agent
      .post("/api/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe("same_password");
  });

  it("needs a session", async () => {
    const res = await request(newApp())
      .post("/api/auth/change-password")
      .send({ currentPassword: "x", newPassword: "a-brand-new-secret" });
    expect(res.status).toBe(401);
  });
});

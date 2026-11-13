import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { signSession, verifySession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// A sign-in ends when its password changes (security audit, finding F1). Before, a session
// lasted its full 7 days whatever happened to the password, so a stolen session outlived
// the password change or owner's reset meant to shut it out.
// Migration 023 keeps users.session_version, raised by the database itself whenever the
// password_hash changes; every session carries the number it was signed with, and
// requireAuth refuses one whose number is no longer current.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

const newApp = () => createApp({ db, jwtSecret: SECRET, production: false });

async function emailOf(id: number): Promise<string> {
  const { rows } = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
  return rows[0].email;
}

async function signedIn(app: ReturnType<typeof newApp>, id: number, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ hostel: "sns-hostel", email: await emailOf(id), password });
  expect(res.status).toBe(200);
  return agent;
}

describe("users.session_version (migration 023)", () => {
  it("goes up when the password changes, and only then", () =>
    inRollback(db, async (c) => {
      const id = await insertStudent(c, { passwordHash });
      const version = async () =>
        (await c.query<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id])).rows[0].v;
      expect(await version()).toBe(0);

      await c.query("UPDATE users SET name = 'Someone Else', must_change_password = true WHERE id = $1", [id]);
      expect(await version()).toBe(0);

      // Writing the same hash again changes nothing.
      await c.query("UPDATE users SET password_hash = password_hash WHERE id = $1", [id]);
      expect(await version()).toBe(0);

      await c.query("UPDATE users SET password_hash = 'another-hash' WHERE id = $1", [id]);
      expect(await version()).toBe(1);
      await c.query("UPDATE users SET password_hash = 'a-third-hash' WHERE id = $1", [id]);
      expect(await version()).toBe(2);
    }));

  it("cannot be set back by the app: the database keeps counting from the old value", () =>
    inRollback(db, async (c) => {
      const id = await insertStudent(c, { passwordHash });
      await c.query("UPDATE users SET password_hash = 'another-hash', session_version = 0 WHERE id = $1", [id]);
      const { rows } = await c.query<{ v: number }>("SELECT session_version AS v FROM users WHERE id = $1", [id]);
      expect(rows[0].v).toBe(1);
    }));

  it("is returned by the sign-in lookups", () =>
    inRollback(db, async (c) => {
      const id = await insertOwner(c, { passwordHash });
      const email = (await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
      const byId = await c.query("SELECT session_version FROM auth_user_by_id($1)", [id]);
      const byEmail = await c.query("SELECT session_version FROM auth_user_by_email(1, $1)", [email]);
      expect(byId.rows).toEqual([{ session_version: 0 }]);
      expect(byEmail.rows).toEqual([{ session_version: 0 }]);
    }));
});

describe("session tokens", () => {
  it("carry the session version", () => {
    const token = signSession({ userId: 7, role: "student", sessionVersion: 3 }, SECRET);
    expect(verifySession(token, SECRET)).toEqual({ userId: 7, role: "student", sessionVersion: 3 });
  });

  it("read a token from before migration 023 as version 0, so nobody is signed out by the upgrade", () => {
    const token = signSession({ userId: 7, role: "owner" }, SECRET);
    expect(verifySession(token, SECRET)?.sessionVersion).toBe(0);
  });
});

describe("a password change ends the other sign-ins", { timeout: 30_000 }, () => {
  it("signs out the user's other devices, and keeps this one signed in", async () => {
    const id = await insertStudent(db, { passwordHash });
    const app = newApp();
    const phone = await signedIn(app, id);
    const laptop = await signedIn(app, id);

    const res = await laptop
      .post("/api/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: "a-brand-new-secret" });
    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/HttpOnly/i);

    expect((await laptop.get("/api/auth/me")).status).toBe(200);
    const stale = await phone.get("/api/auth/me");
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("unauthenticated");
  });

  it("an owner's reset shuts out a stolen session, even after the student picks a new password", async () => {
    const owner = await insertOwner(db, { passwordHash });
    const student = await insertStudent(db, { passwordHash });
    const app = newApp();
    const thief = await signedIn(app, student);
    const ownerAgent = await signedIn(app, owner);

    const reset = await ownerAgent.post(`/api/students/${student}/reset-password`);
    expect(reset.status).toBe(200);
    const { temporaryPassword } = reset.body as { temporaryPassword: string };

    const studentAgent = await signedIn(app, student, temporaryPassword);
    const changed = await studentAgent
      .post("/api/auth/change-password")
      .send({ currentPassword: temporaryPassword, newPassword: "the-students-own-secret" });
    expect(changed.status).toBe(200);

    expect((await studentAgent.get("/api/auth/me")).status).toBe(200);
    expect((await thief.get("/api/auth/me")).status).toBe(401);
    expect((await thief.get("/api/fees/mine")).status).toBe(401);
  });

  it("a forged token with a guessed old version number is refused", async () => {
    const id = await insertStudent(db, { passwordHash });
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash.replace(/.$/, "x"), id]);
    const old = signSession({ userId: id, role: "student", sessionVersion: 0 }, SECRET);
    const res = await request(newApp()).get("/api/auth/me").set("Cookie", `${SESSION_COOKIE}=${old}`);
    expect(res.status).toBe(401);
  });
});

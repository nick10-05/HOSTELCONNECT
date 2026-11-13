import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { LOGIN_LIMITS } from "../src/routes/auth";
import { hashPassword } from "../src/lib/password";
import { insertStudent, testPool } from "./helpers/db";

// Who a run of wrong passwords locks out (security audit). Before, failed logins were
// counted per internet address only: students on one hostel Wi-Fi share one address, so
// anyone there typing 10 wrong passwords, for any email, locked every student on that
// Wi-Fi out for 15 minutes, right password or not. Now:
//   - 10 failures lock that one account, from that one address;
//   - a much higher count per address still stops guessing across many accounts;
//   - a wrong current password when changing it counts against that account only.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

async function emailOf(id: number): Promise<string> {
  const { rows } = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
  return rows[0].email;
}

// production: Render's one proxy is trusted, so X-Forwarded-For names the visitor.
const newApp = (loginLimits?: { perAccount: number; perIp: number }) =>
  createApp({ db, jwtSecret: SECRET, production: true, loginLimits });

const login = (app: ReturnType<typeof newApp>, ip: string, email: string, password: string) =>
  request(app)
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ hostel: "sns-hostel", email, password });

const HOSTEL_WIFI = "203.0.113.5";
const ELSEWHERE = "198.51.100.7";

describe("login limits", { timeout: 60_000 }, () => {
  it("are 10 failures per account and address, and 100 per address", () => {
    expect(LOGIN_LIMITS).toEqual({ perAccount: 10, perIp: 100 });
  });

  it("lock one account at one address, not the other students on the same Wi-Fi", async () => {
    const victim = await emailOf(await insertStudent(db, { passwordHash }));
    const neighbour = await emailOf(await insertStudent(db, { passwordHash }));
    const app = newApp();
    for (let i = 0; i < 10; i++) expect((await login(app, HOSTEL_WIFI, victim, "wrong")).status).toBe(401);

    const locked = await login(app, HOSTEL_WIFI, victim, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("rate_limited");
    expect((await login(app, HOSTEL_WIFI, neighbour, PASSWORD)).status).toBe(200);
    expect((await login(app, ELSEWHERE, victim, PASSWORD)).status).toBe(200);
  });

  it("count the email however it is typed", async () => {
    const email = await emailOf(await insertStudent(db, { passwordHash }));
    const app = newApp({ perAccount: 3, perIp: 100 });
    for (const typed of [email, email.toUpperCase(), `  ${email} `]) await login(app, HOSTEL_WIFI, typed, "wrong");
    expect((await login(app, HOSTEL_WIFI, email, PASSWORD)).status).toBe(429);
  });

  it("stop one address guessing across many accounts", async () => {
    const student = await emailOf(await insertStudent(db, { passwordHash }));
    const app = newApp({ perAccount: 10, perIp: 5 });
    for (let i = 0; i < 5; i++) await login(app, HOSTEL_WIFI, `nobody-${i}@test.local`, "wrong");
    expect((await login(app, HOSTEL_WIFI, student, PASSWORD)).status).toBe(429);
    expect((await login(app, ELSEWHERE, student, PASSWORD)).status).toBe(200);
  });

  it("cannot be dodged by sending a made-up X-Forwarded-For", async () => {
    const email = await emailOf(await insertStudent(db, { passwordHash }));
    const app = newApp({ perAccount: 3, perIp: 100 });
    // Render appends the real address after whatever the visitor sent.
    for (let i = 0; i < 3; i++) await login(app, `10.0.0.${i}, ${HOSTEL_WIFI}`, email, "wrong");
    expect((await login(app, `10.9.9.9, ${HOSTEL_WIFI}`, email, PASSWORD)).status).toBe(429);
  });
});

describe("changing a password", { timeout: 60_000 }, () => {
  it("counts wrong current passwords per account, so one student cannot block another", async () => {
    // Not production: its Secure cookie would not come back over the test's plain HTTP.
    // Both students come from the same address here anyway.
    const app = createApp({ db, jwtSecret: SECRET, production: false });
    const signIn = async () => {
      const email = await emailOf(await insertStudent(db, { passwordHash }));
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ hostel: "sns-hostel", email, password: PASSWORD }).expect(200);
      return agent;
    };
    const change = (agent: request.Agent, currentPassword: string) =>
      agent
        .post("/api/auth/change-password")
        .send({ currentPassword, newPassword: "a-brand-new-secret" });

    const careless = await signIn();
    const other = await signIn();
    for (let i = 0; i < 10; i++) expect((await change(careless, "not-it")).status).toBe(400);
    expect((await change(careless, PASSWORD)).status).toBe(429);
    expect((await change(other, PASSWORD)).status).toBe(200);
  });
});

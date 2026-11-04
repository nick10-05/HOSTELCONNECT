import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { REJOIN_ANSWER, REJOIN_LIMIT_PER_EMAIL, REJOIN_LIMIT_PER_IP } from "../src/routes/rejoin";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// POST /api/rejoin-requests through the real app, service and test database, nothing
// mocked, because the point is that nothing in the answer depends on who the email
// belongs to. Each test builds its own app, so each starts with fresh rate-limit counts.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const freshApp = () => createApp({ db, jwtSecret: SECRET });
const send = (app: ReturnType<typeof freshApp>, body: object) =>
  request(app).post("/api/rejoin-requests").send(body);

const emailOf = async (id: number) =>
  (await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
const requestsOf = async (student: number) =>
  (await db.query("SELECT status, message FROM rejoin_requests WHERE student_id = $1 ORDER BY id", [student])).rows;

// Everything a visitor sees, minus the rate-limit headers (which count down per request).
const visible = (res: request.Response) => ({
  status: res.status,
  type: res.headers["content-type"],
  body: res.body,
});

describe("POST /api/rejoin-requests", () => {
  it("gives exactly the same answer whoever the email belongs to, and records only a former student", async () => {
    const app = freshApp();
    const former = await insertStudent(db, { isActive: false });
    const alreadyAsked = await insertStudent(db, { isActive: false });
    const current = await insertStudent(db);
    const owner = await insertOwner(db);
    await send(app, { email: await emailOf(alreadyAsked), message: "First." });

    const answers = [];
    for (const email of [
      await emailOf(former),
      `nobody-${randomUUID()}@test.local`,
      await emailOf(current),
      await emailOf(owner),
      await emailOf(alreadyAsked),
    ]) {
      answers.push(visible(await send(app, { email, message: "I would like to come back." })));
    }

    expect(answers[0]).toEqual({
      status: 202,
      type: expect.stringContaining("application/json"),
      body: { message: REJOIN_ANSWER },
    });
    for (const answer of answers) expect(answer).toEqual(answers[0]);

    expect(await requestsOf(former)).toEqual([{ status: "pending", message: "I would like to come back." }]);
    expect(await requestsOf(alreadyAsked)).toEqual([{ status: "pending", message: "First." }]);
    expect(await requestsOf(current)).toEqual([]);
    expect(await requestsOf(owner)).toEqual([]);
  });

  it("needs no login, and cleans the email and the message", async () => {
    const app = freshApp();
    const former = await insertStudent(db, { isActive: false });

    const res = await send(app, { email: `  ${(await emailOf(former)).toUpperCase()} `, message: "  Hello.  " });

    expect(res.status).toBe(202);
    expect(await requestsOf(former)).toEqual([{ status: "pending", message: "Hello." }]);
  });

  it("stores no message when it is left out, empty or only spaces", async () => {
    const app = freshApp();
    for (const message of [undefined, "", "   "]) {
      const former = await insertStudent(db, { isActive: false });
      const res = await send(app, { email: await emailOf(former), message });
      expect(res.status).toBe(202);
      expect(await requestsOf(former)).toEqual([{ status: "pending", message: null }]);
    }
  });

  it.each([
    ["a missing email", { message: "Hi." }, "email"],
    ["an email that is not one", { email: "not-an-email" }, "email"],
    ["a message of 501 characters", { email: "someone@test.local", message: "x".repeat(501) }, "message"],
    ["a message with a NUL character", { email: "someone@test.local", message: "Hi\u0000" }, "message"],
  ])("refuses %s with 400", async (_name, body, field) => {
    const res = await send(freshApp(), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(res.body.error.message).toContain(field);
  });

  it("refuses a bad message the same way for a former student's email and an unknown one", async () => {
    const app = freshApp();
    const former = await insertStudent(db, { isActive: false });
    const longMessage = "x".repeat(501);

    const known = await send(app, { email: await emailOf(former), message: longMessage });
    const unknown = await send(app, { email: `nobody-${randomUUID()}@test.local`, message: longMessage });

    expect(visible(known)).toEqual(visible(unknown));
    expect(known.status).toBe(400);
    expect(await requestsOf(former)).toEqual([]);
  });

  it(`allows ${REJOIN_LIMIT_PER_EMAIL} requests per email a day, counting a known and an unknown email alike`, async () => {
    const app = freshApp();
    const former = await emailOf(await insertStudent(db, { isActive: false }));
    const unknown = `nobody-${randomUUID()}@test.local`;

    const answers: Record<string, ReturnType<typeof visible>[]> = { former: [], unknown: [] };
    for (let i = 0; i <= REJOIN_LIMIT_PER_EMAIL; i += 1) {
      answers.former.push(visible(await send(app, { email: former })));
      // Letter case does not make a new email.
      answers.unknown.push(visible(await send(app, { email: i % 2 ? unknown.toUpperCase() : unknown })));
    }

    expect(answers.former.slice(0, REJOIN_LIMIT_PER_EMAIL).every((a) => a.status === 202)).toBe(true);
    expect(answers.former[REJOIN_LIMIT_PER_EMAIL].status).toBe(429);
    expect(answers.unknown).toEqual(answers.former);
    // Another email is not affected.
    expect((await send(app, { email: `other-${randomUUID()}@test.local` })).status).toBe(202);
  });

  it(`allows ${REJOIN_LIMIT_PER_IP} requests per IP an hour, whatever the emails`, async () => {
    const app = freshApp();
    for (let i = 0; i < REJOIN_LIMIT_PER_IP; i += 1) {
      expect((await send(app, { email: `visitor-${randomUUID()}@test.local` })).status).toBe(202);
    }
    const res = await send(app, { email: `visitor-${randomUUID()}@test.local` });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
  });

  it("refuses a cross-site request", async () => {
    const former = await insertStudent(db, { isActive: false });
    const res = await request(freshApp())
      .post("/api/rejoin-requests")
      .set("Origin", "https://elsewhere.example")
      .send({ email: await emailOf(former) });
    expect(res.status).toBe(403);
    expect(await requestsOf(former)).toEqual([]);
  });
});

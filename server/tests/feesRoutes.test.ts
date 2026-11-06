import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The fee routes through the real app and services (day 9): the owner's list, marking a
// fee paid or pending, and a student's own fees. The services' rules are in
// ownerFees.test.ts and myFees.test.ts; these check the HTTP layer: who may call what,
// input checks, India's dates as defaults, status codes and the shape of each answer.
// Each test runs the app on rollbackDb, so everything is rolled back. Fee rows are dated
// 1997, where no other file has any. The clock is 20:00 UTC on 31 July 1997, which is
// already 1 August in India.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("1997-07-31T20:00:00Z");
const INDIA_TODAY = "1997-08-01";

const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

type Ctx = {
  c: PoolClient;
  app: ReturnType<typeof createApp>;
  owner: string;
  ownerId: number;
  student: string;
  studentId: number;
};

function withApp(fn: (ctx: Ctx) => Promise<void>) {
  return inRollback(db, async (c) => {
    const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET, clock: () => NOW });
    const ownerId = await insertOwner(c);
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                          phone, parent_phone, category, joining_date, food_preference, monthly_fee)
       VALUES ('student', 'Asha', $1, 'not-a-real-hash', false, true,
               '9000000000', '9000000001', 'other', '1997-01-01', 'veg', 6500) RETURNING id`,
      [`feeroutes-${randomUUID()}@test.local`],
    );
    const studentId = rows[0].id;
    await fn({ c, app, owner: cookieFor(ownerId, "owner"), ownerId, student: cookieFor(studentId, "student"), studentId });
  });
}

async function fee(c: PoolClient, studentId: number, due: string, paidOn?: string): Promise<number> {
  const recorder = paidOn ? await insertOwner(c) : null;
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO fees (student_id, due_date, amount, status, paid_on, recorded_by)
     VALUES ($1, $2, 6500, $3, $4, $5) RETURNING id`,
    [studentId, due, paidOn ? "paid" : "pending", paidOn ?? null, recorder],
  );
  return rows[0].id;
}

const rowOf = async (c: PoolClient, id: number) =>
  (await c.query(`SELECT status, paid_on AS "paidOn", note FROM fees WHERE id = $1`, [id])).rows[0];

const expect400 = (res: request.Response, label: string) => {
  expect(res.status, label).toBe(400);
  expect(res.body.error.code, label).toBe("invalid_input");
};

describe("who may use the fee routes", () => {
  it("need a session", () =>
    withApp(async ({ c, app, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      expect((await request(app).get("/api/fees")).status).toBe(401);
      expect((await request(app).get("/api/fees/mine")).status).toBe(401);
      expect((await request(app).post(`/api/fees/${id}/status`).send({ status: "paid" })).status).toBe(401);
    }));

  it("let a student read only their own fees, never the list or a status change", () =>
    withApp(async ({ c, app, student, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      expect((await request(app).get("/api/fees/mine").set("Cookie", student)).status).toBe(200);
      for (const res of [
        await request(app).get("/api/fees").set("Cookie", student),
        await request(app).post(`/api/fees/${id}/status`).set("Cookie", student).send({ status: "paid" }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
      expect(await rowOf(c, id)).toMatchObject({ status: "pending" });
    }));

  it("give the owner no 'my fees'", () =>
    withApp(async ({ app, owner }) => {
      const res = await request(app).get("/api/fees/mine").set("Cookie", owner);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }));

  it("refuse an owner who still has a temporary password, and a change sent from another site", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      const temporary = cookieFor(await insertOwner(c, { mustChangePassword: true }), "owner");
      const res = await request(app).post(`/api/fees/${id}/status`).set("Cookie", temporary).send({ status: "paid" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");

      const cross = await request(app)
        .post(`/api/fees/${id}/status`)
        .set("Cookie", owner)
        .set("Origin", "https://elsewhere.example")
        .send({ status: "paid" });
      expect(cross.status).toBe(403);
      expect(cross.body.error.code).toBe("cross_origin");
      expect(await rowOf(c, id)).toMatchObject({ status: "pending" });
    }));
});

describe("GET /api/fees", () => {
  it("lists India's current month by default, with totals, and is never cached", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      await fee(c, studentId, "1997-07-14"); // July: not this month in India
      const august = await fee(c, studentId, "1997-08-14");

      const res = await request(app).get("/api/fees").set("Cookie", owner);

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([august]);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0]).toMatchObject({ studentId, studentName: "Asha", dueDate: "1997-08-14", state: "upcoming" });
      expect(res.body.totals).toEqual({
        paid: { count: 0, amount: 0 },
        pending: { count: 1, amount: 6500 },
        overdue: { count: 0, amount: 0 },
        amountNotSet: 0,
      });
    }));

  it("takes a month, a status, a building and a page", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const overdue = await fee(c, studentId, "1997-07-14");
      await fee(c, studentId, "1997-07-20", "1997-07-20");
      const res = await request(app).get("/api/fees?month=1997-07&status=overdue&page=1&limit=5").set("Cookie", owner);
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([overdue]);
      expect(res.body.items[0].state).toBe("overdue"); // overdue by India's 1 August
      const building = await request(app).get("/api/fees?month=1997-07&buildingId=999999999").set("Cookie", owner);
      expect(building.body.items).toEqual([]);
    }));

  it("checks every filter", () =>
    withApp(async ({ app, owner }) => {
      for (const q of ["month=1997-7", "month=1997-13", "month=july", "month=1997-07-01", "status=late",
                       "buildingId=abc", "buildingId=0", "page=0", "limit=51"]) {
        expect400(await request(app).get(`/api/fees?${q}`).set("Cookie", owner), q);
      }
    }));
});

describe("POST /api/fees/:id/status", () => {
  it("marks paid on India's today by default, with the note trimmed", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      const res = await request(app)
        .post(`/api/fees/${id}/status`)
        .set("Cookie", owner)
        .send({ status: "paid", note: "  paid by UPI \n" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        studentId,
        dueDate: "1997-07-14",
        amount: 6500,
        status: "paid",
        paidOn: INDIA_TODAY,
        note: "paid by UPI",
      });
      const { rows } = await c.query(`SELECT title FROM notifications WHERE user_id = $1`, [studentId]);
      expect(rows).toEqual([{ title: "Your fee payment was recorded." }]);
    }));

  it("takes a given payment date, and a blank note as no note", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      const res = await request(app)
        .post(`/api/fees/${id}/status`)
        .set("Cookie", owner)
        .send({ status: "paid", paidOn: "1997-07-30", note: "   " });
      expect(res.status).toBe(200);
      expect(await rowOf(c, id)).toEqual({ status: "paid", paidOn: "1997-07-30", note: null });
    }));

  it("marks a fee pending again", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14", "1997-07-15");
      const res = await request(app).post(`/api/fees/${id}/status`).set("Cookie", owner).send({ status: "pending" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: "pending", paidOn: null, note: null });
    }));

  it("checks the body", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      for (const body of [
        {},
        { status: "overdue" },
        { status: "paid", paidOn: "1997-02-30" },
        { status: "paid", paidOn: "01-08-1997" },
        { status: "paid", note: "x".repeat(201) },
        { status: "paid", note: 42 },
        { status: "pending", paidOn: "1997-07-30" },
        { status: "pending", note: "why" },
      ]) {
        expect400(await request(app).post(`/api/fees/${id}/status`).set("Cookie", owner).send(body), JSON.stringify(body));
      }
      expect(await rowOf(c, id)).toEqual({ status: "pending", paidOn: null, note: null });
      const ok = await request(app).post(`/api/fees/${id}/status`).set("Cookie", owner).send({ status: "paid", note: "💸".repeat(200) });
      expect(ok.status).toBe(200);
    }));

  it("refuses a payment date after India's today", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const id = await fee(c, studentId, "1997-07-14");
      const res = await request(app).post(`/api/fees/${id}/status`).set("Cookie", owner).send({ status: "paid", paidOn: "1997-08-02" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "paid_on_in_future", message: "The payment date cannot be after today." } });
      // India's today (1 August) is fine, although it is still 31 July in UTC.
      const today = await request(app).post(`/api/fees/${id}/status`).set("Cookie", owner).send({ status: "paid", paidOn: INDIA_TODAY });
      expect(today.status).toBe(200);
    }));

  it("answers 409 for a fee already in that state, and 404 for an unknown one", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const paid = await fee(c, studentId, "1997-07-14", "1997-07-15");
      const res = await request(app).post(`/api/fees/${paid}/status`).set("Cookie", owner).send({ status: "paid" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("fee_already_paid");

      const missing = await request(app).post("/api/fees/999999999/status").set("Cookie", owner).send({ status: "pending" });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: { code: "fee_not_found", message: "That fee does not exist." } });
      expect((await request(app).post("/api/fees/abc/status").set("Cookie", owner).send({ status: "pending" })).status).toBe(404);
    }));
});

describe("GET /api/fees/mine", () => {
  it("gives the student's own fees on India's today, and is never cached", () =>
    withApp(async ({ c, app, student, studentId }) => {
      const july = await fee(c, studentId, "1997-07-14");
      const august = await fee(c, studentId, "1997-08-01"); // due on India's today
      await fee(c, await insertStudent(c), "1997-07-20"); // another student's: not in this answer

      const res = await request(app).get("/api/fees/mine").set("Cookie", student);

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        pendingBalance: 13_000,
        amountNotSet: 0,
        overdue: [expect.objectContaining({ id: july })],
        upcoming: [],
        history: [expect.objectContaining({ id: august }), expect.objectContaining({ id: july })],
        nextDueDate: "1997-08-01",
      });
    }));
});

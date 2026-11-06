import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inSnapshot, insertOwner, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The return-poll routes through the real app and services (day 9). Starting a poll
// notifies every active student, so each test runs the app on its own connection inside a
// transaction that is rolled back (tests/helpers/rollbackDb.ts), with one snapshot
// (REPEATABLE READ), as in announcementsRoutes.test.ts. The services' own rules are in
// returnPolls.test.ts and returnPollResults.test.ts; these check the HTTP layer: who may
// call what, input checks, status codes and the shape of each answer.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

const TITLE = "Back after Diwali?";
const POLL_FIELDS = ["closedAt", "createdAt", "id", "status", "title"];
const NOT_FOUND = { error: { code: "poll_not_found", message: "That poll does not exist." } };
const CLOSED = { error: { code: "poll_closed", message: "That poll is closed." } };

type Ctx = { c: PoolClient; app: ReturnType<typeof createApp>; owner: string; student: string; studentId: number };

function withApp(fn: (ctx: Ctx) => Promise<void>) {
  return inSnapshot(db, async (c) => {
    const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET });
    const studentId = await insertStudent(c);
    await fn({ c, app, owner: cookieFor(await insertOwner(c), "owner"), student: cookieFor(studentId, "student"), studentId });
  });
}

const count = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(sql, params)).rows[0].n;
const pollCount = (c: PoolClient) => count(c, "SELECT count(*)::int AS n FROM return_polls");

// A poll written straight to the table, without notifying anyone.
async function addPoll(c: PoolClient, open = true): Promise<number> {
  const owner = await insertOwner(c);
  const { rows } = await c.query<{ id: number }>(
    open
      ? `INSERT INTO return_polls (title, created_by) VALUES ($1, $2) RETURNING id`
      : `INSERT INTO return_polls (title, created_by, status, closed_at) VALUES ($1, $2, 'closed', now()) RETURNING id`,
    [TITLE, owner],
  );
  return rows[0].id;
}

describe("who may use the return-poll routes", () => {
  it("need a session", () =>
    withApp(async ({ c, app }) => {
      const id = await addPoll(c);
      for (const res of [
        await request(app).get("/api/return-polls"),
        await request(app).post("/api/return-polls").send({ title: TITLE }),
        await request(app).get(`/api/return-polls/${id}`),
        await request(app).put(`/api/return-polls/${id}/response`).send({ response: "returned" }),
        await request(app).post(`/api/return-polls/${id}/close`),
      ]) {
        expect(res.status).toBe(401);
      }
    }));

  it("let a student list and answer, but not start, close or see results", () =>
    withApp(async ({ c, app, student }) => {
      const id = await addPoll(c);
      const before = await pollCount(c);

      expect((await request(app).get("/api/return-polls").set("Cookie", student)).status).toBe(200);
      expect(
        (await request(app).put(`/api/return-polls/${id}/response`).set("Cookie", student).send({ response: "returned" }))
          .status,
      ).toBe(200);
      for (const res of [
        await request(app).post("/api/return-polls").set("Cookie", student).send({ title: "Mine" }),
        await request(app).get(`/api/return-polls/${id}`).set("Cookie", student),
        await request(app).post(`/api/return-polls/${id}/close`).set("Cookie", student),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
      expect(await pollCount(c)).toBe(before);
      expect((await c.query("SELECT status FROM return_polls WHERE id = $1", [id])).rows).toEqual([{ status: "open" }]);
    }));

  it("do not let the owner answer a poll", () =>
    withApp(async ({ c, app, owner }) => {
      const id = await addPoll(c);
      const res = await request(app).put(`/api/return-polls/${id}/response`).set("Cookie", owner).send({ response: "returned" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(await count(c, "SELECT count(*)::int AS n FROM return_poll_responses WHERE poll_id = $1", [id])).toBe(0);
    }));

  it("refuse an owner who still has a temporary password", () =>
    withApp(async ({ c, app }) => {
      const owner = cookieFor(await insertOwner(c, { mustChangePassword: true }), "owner");
      const res = await request(app).post("/api/return-polls").set("Cookie", owner).send({ title: TITLE });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");
    }));

  it("refuse a write sent from another site's page", () =>
    withApp(async ({ c, app, owner, student }) => {
      const id = await addPoll(c);
      const before = await pollCount(c);
      for (const [req, cookie] of [
        [request(app).post("/api/return-polls").send({ title: "Another" }), owner],
        [request(app).post(`/api/return-polls/${id}/close`), owner],
        [request(app).put(`/api/return-polls/${id}/response`).send({ response: "returned" }), student],
      ] as const) {
        const res = await req.set("Cookie", cookie).set("Origin", "https://elsewhere.example");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("cross_origin");
      }
      expect(await pollCount(c)).toBe(before);
      expect((await c.query("SELECT status FROM return_polls WHERE id = $1", [id])).rows).toEqual([{ status: "open" }]);
    }));
});

describe("POST /api/return-polls", () => {
  it("starts a poll with the title trimmed, answers 201, and notifies every active student", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const res = await request(app).post("/api/return-polls").set("Cookie", owner).send({ title: `  ${TITLE}\n` });

      expect(res.status).toBe(201);
      expect(Object.keys(res.body).sort()).toEqual(POLL_FIELDS);
      expect(res.body).toMatchObject({ title: TITLE, status: "open", closedAt: null });
      const active = await count(c, "SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_active");
      expect(
        await count(c, "SELECT count(*)::int AS n FROM notifications WHERE dedup_key = $1", [`return_poll:${res.body.id}`]),
      ).toBe(active);
      const { rows } = await c.query("SELECT type, title, link FROM notifications WHERE user_id = $1", [studentId]);
      expect(rows).toEqual([{ type: "return_poll", title: "New return poll from the hostel.", link: "/" }]);
    }));

  it("takes 1 to 120 characters, counted as the database counts them", () =>
    withApp(async ({ c, app, owner }) => {
      const before = await pollCount(c);
      for (const body of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(121) }, { title: "🏠".repeat(121) },
                          { title: 42 }, { title: "a\u0000b" }]) {
        const res = await request(app).post("/api/return-polls").set("Cookie", owner).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe("invalid_input");
      }
      expect(await pollCount(c)).toBe(before);
      const res = await request(app).post("/api/return-polls").set("Cookie", owner).send({ title: "🏠".repeat(120) });
      expect(res.status).toBe(201);
    }));

  it("answers 409 while another poll is open", () =>
    withApp(async ({ c, app, owner }) => {
      await addPoll(c);
      const res = await request(app).post("/api/return-polls").set("Cookie", owner).send({ title: TITLE });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: { code: "poll_already_open", message: "A return poll is already open. Close it before starting another." },
      });
    }));
});

describe("POST /api/return-polls/:id/close", () => {
  it("closes an open poll, then refuses to close it again", () =>
    withApp(async ({ c, app, owner }) => {
      const id = await addPoll(c);
      const res = await request(app).post(`/api/return-polls/${id}/close`).set("Cookie", owner);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(POLL_FIELDS);
      expect(res.body).toMatchObject({ id, status: "closed", closedAt: expect.any(String) });

      const again = await request(app).post(`/api/return-polls/${id}/close`).set("Cookie", owner);
      expect(again.status).toBe(409);
      expect(again.body).toEqual(CLOSED);
    }));

  it("answers 404 for an unknown poll or an id that is not a number", () =>
    withApp(async ({ app, owner }) => {
      const res = await request(app).post("/api/return-polls/999999999/close").set("Cookie", owner);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect((await request(app).post("/api/return-polls/abc/close").set("Cookie", owner)).status).toBe(404);
    }));
});

describe("GET /api/return-polls", () => {
  it("gives the owner every poll newest first, with counts, a total and no caching", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const older = await addPoll(c, false);
      const newer = await addPoll(c);
      await c.query(`INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, 'returned')`, [
        newer,
        studentId,
      ]);

      const res = await request(app).get("/api/return-polls?limit=2").set("Cookie", owner);

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.total).toBeGreaterThanOrEqual(2);
      expect(res.body.items.map((p: { id: number }) => p.id)).toEqual([newer, older]);
      expect(Object.keys(res.body.items[0]).sort()).toEqual([...POLL_FIELDS, "counts"].sort());
      expect(res.body.items[0].counts).toMatchObject({ returned: 1, notYet: 0 });
    }));

  it("checks page and limit", () =>
    withApp(async ({ app, owner }) => {
      for (const q of ["page=0", "limit=0", "limit=51", "page=abc"]) {
        const res = await request(app).get(`/api/return-polls?${q}`).set("Cookie", owner);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code).toBe("invalid_input");
      }
    }));

  it("gives a student the open poll with only their own answer, and no caching", () =>
    withApp(async ({ c, app, student }) => {
      await addPoll(c, false);
      const open = await addPoll(c);
      const other = await insertStudent(c);
      await c.query(`INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, 'returned')`, [
        open,
        other,
      ]);

      let res = await request(app).get("/api/return-polls").set("Cookie", student);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        items: [{ id: open, title: TITLE, createdAt: expect.any(String), myResponse: null, respondedAt: null }],
        total: 1,
      });

      await request(app).put(`/api/return-polls/${open}/response`).set("Cookie", student).send({ response: "not_yet" });
      res = await request(app).get("/api/return-polls").set("Cookie", student);
      expect(res.body.items[0]).toMatchObject({ myResponse: "not_yet", respondedAt: expect.any(String) });
    }));
});

describe("GET /api/return-polls/:id", () => {
  it("gives the owner the three lists and counts, filtered by building, with no caching", () =>
    withApp(async ({ c, app, owner }) => {
      const name = `Poll ${randomUUID()}`;
      const building = (await c.query<{ id: number }>("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]))
        .rows[0].id;
      const s = await insertStudent(c);
      await c.query(
        `INSERT INTO stays (student_id, building_id, started_on, created_by) VALUES ($1, $2, '2026-01-14', $3)`,
        [s, building, await insertOwner(c)],
      );
      const id = await addPoll(c, false);
      await c.query(`INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, 'not_yet')`, [id, s]);

      const res = await request(app).get(`/api/return-polls/${id}?buildingId=${building}`).set("Cookie", owner);

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        poll: { id, title: TITLE, status: "closed", createdAt: expect.any(String), closedAt: expect.any(String) },
        counts: { returned: 0, notYet: 1, noResponse: 0 },
        returned: [],
        notYet: [
          {
            studentId: s,
            name: "Test Student",
            buildingId: building,
            buildingName: name,
            roomNumber: null,
            respondedAt: expect.any(String),
          },
        ],
        noResponse: [],
      });

      const all = await request(app).get(`/api/return-polls/${id}`).set("Cookie", owner);
      expect(all.status).toBe(200);
      expect(all.body.counts.noResponse).toBeGreaterThanOrEqual(1);
    }));

  it("checks the building and the poll", () =>
    withApp(async ({ c, app, owner }) => {
      const id = await addPoll(c, false);
      for (const q of ["buildingId=abc", "buildingId=0", "buildingId=-3", "buildingId=1.5"]) {
        const res = await request(app).get(`/api/return-polls/${id}?${q}`).set("Cookie", owner);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code).toBe("invalid_input");
      }
      const missing = await request(app).get("/api/return-polls/999999999").set("Cookie", owner);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual(NOT_FOUND);
    }));
});

describe("PUT /api/return-polls/:id/response", () => {
  it("records and changes the student's answer", () =>
    withApp(async ({ c, app, student, studentId }) => {
      const id = await addPoll(c);
      let res = await request(app).put(`/api/return-polls/${id}/response`).set("Cookie", student).send({ response: "not_yet" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pollId: id, response: "not_yet", respondedAt: expect.any(String) });

      res = await request(app).put(`/api/return-polls/${id}/response`).set("Cookie", student).send({ response: "returned" });
      expect(res.status).toBe(200);
      const { rows } = await c.query("SELECT response FROM return_poll_responses WHERE poll_id = $1 AND student_id = $2", [
        id,
        studentId,
      ]);
      expect(rows).toEqual([{ response: "returned" }]);
    }));

  it("takes 'returned' or 'not_yet' only", () =>
    withApp(async ({ c, app, student }) => {
      const id = await addPoll(c);
      for (const body of [{}, { response: "yes" }, { response: "Returned" }, { response: null }, { response: true }]) {
        const res = await request(app).put(`/api/return-polls/${id}/response`).set("Cookie", student).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe("invalid_input");
      }
      expect(await count(c, "SELECT count(*)::int AS n FROM return_poll_responses WHERE poll_id = $1", [id])).toBe(0);
    }));

  it("answers 409 for a closed poll and 404 for an unknown one", () =>
    withApp(async ({ c, app, student }) => {
      const closed = await addPoll(c, false);
      const res = await request(app).put(`/api/return-polls/${closed}/response`).set("Cookie", student).send({ response: "returned" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual(CLOSED);

      const missing = await request(app)
        .put("/api/return-polls/999999999/response")
        .set("Cookie", student)
        .send({ response: "returned" });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual(NOT_FOUND);
    }));
});

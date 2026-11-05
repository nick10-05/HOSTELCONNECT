import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The announcement routes through the real app and services. Posting notifies every
// active student, so each test runs the app on its own connection inside a transaction
// that is rolled back (tests/helpers/rollbackDb.ts), with one snapshot (REPEATABLE READ)
// so "every active student" is counted on the same data. Every test builds its own app.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

const NOTICE = {
  title: "Water off on Sunday",
  body: "The tank is being cleaned from 9 am to 1 pm. Please store water the night before.",
};
const FIELDS = ["body", "createdAt", "id", "isPinned", "isUrgent", "title", "updatedAt"];
const NOT_FOUND = { error: { code: "announcement_not_found", message: "That announcement does not exist." } };

type Ctx = { c: PoolClient; app: ReturnType<typeof createApp>; owner: string; student: string; studentId: number };

function withApp(fn: (ctx: Ctx) => Promise<void>) {
  return inRollback(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET });
    const studentId = await insertStudent(c);
    await fn({ c, app, owner: cookieFor(await insertOwner(c), "owner"), student: cookieFor(studentId, "student"), studentId });
  });
}

const count = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(sql, params)).rows[0].n;
const announcementCount = (c: PoolClient) => count(c, "SELECT count(*)::int AS n FROM announcements");
const notificationsFor = (c: PoolClient, id: number) =>
  count(c, "SELECT count(*)::int AS n FROM notifications WHERE dedup_key = $1", [`announcement:${id}`]);

// An announcement written straight to the table, without notifying anyone.
async function addAnnouncement(c: PoolClient, opts: { pinned?: boolean; at?: string } = {}) {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO announcements (author_id, title, body, is_pinned, created_at, updated_at)
     VALUES ($1, 'Notice', 'Text of the notice.', $2, $3, $3) RETURNING id`,
    [await insertOwner(c), opts.pinned ?? false, opts.at ?? "2026-11-01T09:00:00Z"],
  );
  return rows[0].id;
}

describe("who may use the announcement routes", () => {
  it("need a session", () =>
    withApp(async ({ c, app }) => {
      const id = await addAnnouncement(c);
      expect((await request(app).get("/api/announcements")).status).toBe(401);
      expect((await request(app).post("/api/announcements").send(NOTICE)).status).toBe(401);
      expect((await request(app).patch(`/api/announcements/${id}`).send({ isPinned: true })).status).toBe(401);
      expect((await request(app).delete(`/api/announcements/${id}`)).status).toBe(401);
    }));

  it("let a student read, but not post, edit or delete", () =>
    withApp(async ({ c, app, student }) => {
      const id = await addAnnouncement(c);
      const before = await announcementCount(c);

      expect((await request(app).get("/api/announcements").set("Cookie", student)).status).toBe(200);
      for (const res of [
        await request(app).post("/api/announcements").set("Cookie", student).send(NOTICE),
        await request(app).patch(`/api/announcements/${id}`).set("Cookie", student).send({ isPinned: true }),
        await request(app).delete(`/api/announcements/${id}`).set("Cookie", student),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("forbidden");
      }
      expect(await announcementCount(c)).toBe(before);
      const { rows } = await c.query("SELECT is_pinned FROM announcements WHERE id = $1", [id]);
      expect(rows).toEqual([{ is_pinned: false }]);
    }));

  it("refuse an owner who still has a temporary password", () =>
    withApp(async ({ c, app }) => {
      const owner = cookieFor(await insertOwner(c, { mustChangePassword: true }), "owner");
      const res = await request(app).post("/api/announcements").set("Cookie", owner).send(NOTICE);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");
    }));

  it("refuse a write sent from another site's page", () =>
    withApp(async ({ c, app, owner }) => {
      const id = await addAnnouncement(c);
      const before = await announcementCount(c);
      for (const req of [
        request(app).post("/api/announcements").send(NOTICE),
        request(app).patch(`/api/announcements/${id}`).send({ isPinned: true }),
        request(app).delete(`/api/announcements/${id}`),
      ]) {
        const res = await req.set("Cookie", owner).set("Origin", "https://elsewhere.example");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("cross_origin");
      }
      expect(await announcementCount(c)).toBe(before);
    }));
});

describe("POST /api/announcements", () => {
  it("posts with the text trimmed and the defaults, answers 201, and notifies every active student", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const res = await request(app)
        .post("/api/announcements")
        .set("Cookie", owner)
        .send({ title: `  ${NOTICE.title} `, body: `${NOTICE.body}\n` });

      expect(res.status).toBe(201);
      expect(Object.keys(res.body).sort()).toEqual(FIELDS);
      expect(res.body).toMatchObject({ ...NOTICE, isUrgent: false, isPinned: false });
      const active = await count(c, "SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_active");
      expect(await notificationsFor(c, res.body.id)).toBe(active);
      const { rows } = await c.query("SELECT title, body, link FROM notifications WHERE user_id = $1", [studentId]);
      expect(rows).toEqual([{ title: "New notice from the hostel.", body: null, link: "/notices" }]);
    }));

  it("takes urgent and pinned when given", () =>
    withApp(async ({ app, owner }) => {
      const res = await request(app)
        .post("/api/announcements")
        .set("Cookie", owner)
        .send({ ...NOTICE, isUrgent: true, isPinned: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ isUrgent: true, isPinned: true });
    }));

  it("accepts 120 and 2000 characters, counted as the database counts them", () =>
    withApp(async ({ app, owner }) => {
      for (const body of [
        { title: "x".repeat(120), body: "y".repeat(2000) },
        { title: "📢".repeat(120), body: "🚿".repeat(2000) },
      ]) {
        const res = await request(app).post("/api/announcements").set("Cookie", owner).send(body);
        expect(res.status).toBe(201);
      }
    }));

  it("refuses a bad title, body or flag with 400 and posts nothing", () =>
    withApp(async ({ c, app, owner }) => {
      const before = await announcementCount(c);
      for (const body of [
        {},
        { title: NOTICE.title },
        { body: NOTICE.body },
        { ...NOTICE, title: "" },
        { ...NOTICE, title: "   " },
        { ...NOTICE, title: "x".repeat(121) },
        { ...NOTICE, title: "📢".repeat(121) },
        { ...NOTICE, body: "\n\t " },
        { ...NOTICE, body: "y".repeat(2001) },
        { ...NOTICE, title: "Bad \u0000 title" },
        { ...NOTICE, body: "Bad \u0000 body" },
        { ...NOTICE, title: 42 },
        { ...NOTICE, isUrgent: "yes" },
        { ...NOTICE, isPinned: 1 },
      ]) {
        const res = await request(app).post("/api/announcements").set("Cookie", owner).send(body);
        expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
        expect(res.body.error.code).toBe("invalid_input");
      }
      expect(await announcementCount(c)).toBe(before);
    }));
});

describe("PATCH /api/announcements/:id", () => {
  it("edits each field on its own, and never notifies again", () =>
    withApp(async ({ c, app, owner }) => {
      const posted = (await request(app).post("/api/announcements").set("Cookie", owner).send(NOTICE)).body;
      const notified = await notificationsFor(c, posted.id);
      const all = await count(c, "SELECT count(*)::int AS n FROM notifications");
      const edit = (body: object) => request(app).patch(`/api/announcements/${posted.id}`).set("Cookie", owner).send(body);

      const titled = await edit({ title: " Water off on Monday " });
      expect(titled.status).toBe(200);
      expect(titled.body).toMatchObject({ title: "Water off on Monday", body: NOTICE.body });
      expect((await edit({ body: "Moved to Monday." })).body).toMatchObject({ body: "Moved to Monday." });
      expect((await edit({ isUrgent: true })).body).toMatchObject({ isUrgent: true, isPinned: false });
      expect((await edit({ isPinned: true, isUrgent: false })).body).toMatchObject({ isUrgent: false, isPinned: true });

      expect(await notificationsFor(c, posted.id)).toBe(notified);
      expect(await count(c, "SELECT count(*)::int AS n FROM notifications")).toBe(all);
    }));

  it("accepts only these four fields, at least one, each valid: anything else is 400 and changes nothing", () =>
    withApp(async ({ c, app, owner }) => {
      const id = await addAnnouncement(c);
      const before = (await c.query("SELECT * FROM announcements WHERE id = $1", [id])).rows[0];
      for (const body of [
        {},
        { authorId: 1 },
        { createdAt: "2026-01-01T00:00:00Z" },
        { isPinned: true, author_id: 1 },
        { title: "" },
        { title: "x".repeat(121) },
        { body: "  " },
        { isUrgent: null },
        { isPinned: "true" },
      ]) {
        const res = await request(app).patch(`/api/announcements/${id}`).set("Cookie", owner).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code, JSON.stringify(body)).toBe("invalid_input");
      }
      expect((await c.query("SELECT * FROM announcements WHERE id = $1", [id])).rows[0]).toEqual(before);
    }));

  it("answers a missing announcement with 404, and a non-number id with a plain 404", () =>
    withApp(async ({ app, owner }) => {
      const missing = await request(app).patch("/api/announcements/999999999").set("Cookie", owner).send({ isPinned: true });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual(NOT_FOUND);
      expect((await request(app).patch("/api/announcements/abc").set("Cookie", owner).send({ isPinned: true })).status).toBe(404);
    }));
});

describe("DELETE /api/announcements/:id", () => {
  it("deletes the announcement and its notifications, answers 204, then 404", () =>
    withApp(async ({ c, app, owner }) => {
      const posted = (await request(app).post("/api/announcements").set("Cookie", owner).send(NOTICE)).body;
      const other = (await request(app).post("/api/announcements").set("Cookie", owner).send({ ...NOTICE, title: "Mess closed" })).body;
      const otherNotified = await notificationsFor(c, other.id);
      expect(await notificationsFor(c, posted.id)).toBeGreaterThan(0);

      const res = await request(app).delete(`/api/announcements/${posted.id}`).set("Cookie", owner);

      expect(res.status).toBe(204);
      expect(res.text).toBe("");
      expect(await count(c, "SELECT count(*)::int AS n FROM announcements WHERE id = $1", [posted.id])).toBe(0);
      expect(await notificationsFor(c, posted.id)).toBe(0);
      expect(await notificationsFor(c, other.id)).toBe(otherNotified);

      const again = await request(app).delete(`/api/announcements/${posted.id}`).set("Cookie", owner);
      expect(again.status).toBe(404);
      expect(again.body).toEqual(NOT_FOUND);
      expect((await request(app).delete("/api/announcements/0").set("Cookie", owner)).status).toBe(404);
    }));
});

describe("GET /api/announcements", () => {
  it("lists pinned first, then newest, pages, and shows students the same list as the owner", () =>
    withApp(async ({ c, app, owner, student }) => {
      // Far in the future, so these come before anything else in the table.
      const plainNew = await addAnnouncement(c, { at: "2999-01-04T09:00:00Z" });
      const pinnedOld = await addAnnouncement(c, { pinned: true, at: "2999-01-01T09:00:00Z" });
      const plainOld = await addAnnouncement(c, { at: "2999-01-02T09:00:00Z" });

      const res = await request(app).get("/api/announcements?limit=50").set("Cookie", owner);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["items", "total"]);
      const ids: number[] = res.body.items.map((a: { id: number }) => a.id);
      expect(ids[0]).toBe(pinnedOld);
      expect(ids.filter((id) => [plainNew, pinnedOld, plainOld].includes(id))).toEqual([pinnedOld, plainNew, plainOld]);
      expect(res.body.total).toBe(await announcementCount(c));
      for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(FIELDS);

      const asStudent = await request(app).get("/api/announcements?limit=50").set("Cookie", student);
      expect(asStudent.body).toEqual(res.body);

      const page2 = await request(app).get("/api/announcements?limit=1&page=2").set("Cookie", student);
      expect(page2.body.items.map((a: { id: number }) => a.id)).toEqual([ids[1]]);
      for (const q of ["page=0", "limit=51", "limit=abc"]) {
        expect((await request(app).get(`/api/announcements?${q}`).set("Cookie", student)).status, q).toBe(400);
      }
    }));
});

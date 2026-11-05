import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// The bell's routes through the real app, services and test database: the point is that
// each person reaches only their own notifications, whoever asks. The people here never
// receive a broadcast from another test file: owners, or students created and read
// within one test (see tests/notifications.test.ts for why that matters).
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const app = createApp({ db, jwtSecret: SECRET });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

async function add(user: number, title: string, minutesAgo = 0): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO notifications (user_id, type, title, link, created_at)
     VALUES ($1, 'announcement', $2, '/announcements/1', now() - make_interval(mins => $3)) RETURNING id`,
    [user, title, minutesAgo],
  );
  return rows[0].id;
}

const readAt = async (id: number) =>
  (await db.query("SELECT read_at FROM notifications WHERE id = $1", [id])).rows[0].read_at;

describe("the notification routes", () => {
  it("need a session, and nothing else: a student and the owner both have a bell", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
    expect((await request(app).post("/api/notifications/read-all")).status).toBe(401);
    expect((await request(app).post("/api/notifications/1/read")).status).toBe(401);

    const owner = await insertOwner(db);
    expect((await request(app).get("/api/notifications").set("Cookie", cookieFor(owner, "owner"))).status).toBe(200);
  });

  it("are closed to someone who still has a temporary password", async () => {
    const owner = await insertOwner(db, { mustChangePassword: true });
    const res = await request(app).get("/api/notifications").set("Cookie", cookieFor(owner, "owner"));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("password_change_required");
  });
});

describe("GET /api/notifications", () => {
  it("lists only the caller's own, newest first, with the total and unread count", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    await add(owner, "Older", 10);
    const newest = await add(owner, "Newer", 1);
    await add(student, "Not the owner's");

    const res = await request(app).get("/api/notifications").set("Cookie", cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, unread: 2 });
    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual(["Newer", "Older"]);
    expect(res.body.items[0]).toEqual({
      id: newest,
      type: "announcement",
      title: "Newer",
      body: null,
      link: "/announcements/1",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      readAt: null,
    });
  });

  it("pages, 20 by default and at most 50", async () => {
    const owner = await insertOwner(db);
    for (let i = 0; i < 3; i += 1) await add(owner, `Notice ${i}`, i);
    const get = (query: string) =>
      request(app).get(`/api/notifications${query}`).set("Cookie", cookieFor(owner, "owner"));

    expect((await get("?page=2&limit=2")).body.items.map((n: { title: string }) => n.title)).toEqual(["Notice 2"]);
    expect((await get("?limit=51")).status).toBe(400);
    expect((await get("?page=0")).status).toBe(400);
  });
});

describe("POST /api/notifications/:id/read", () => {
  it("marks the caller's own notification read and answers 204", async () => {
    const owner = await insertOwner(db);
    const id = await add(owner, "Mine");

    const res = await request(app).post(`/api/notifications/${id}/read`).set("Cookie", cookieFor(owner, "owner"));

    expect(res.status).toBe(204);
    expect(await readAt(id)).toBeInstanceOf(Date);
  });

  it("answers someone else's notification exactly like one that does not exist", async () => {
    const owner = await insertOwner(db);
    const theirs = await add(await insertOwner(db), "Theirs");
    const post = (id: number) =>
      request(app).post(`/api/notifications/${id}/read`).set("Cookie", cookieFor(owner, "owner"));

    const other = await post(theirs);
    const missing = await post(999_999_999);

    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(await readAt(theirs)).toBeNull();
  });

  it("answers 404 for an id that is not a positive number", async () => {
    const owner = await insertOwner(db);
    const res = await request(app).post("/api/notifications/abc/read").set("Cookie", cookieFor(owner, "owner"));
    expect(res.status).toBe(404);
  });

  it("refuses a cross-site request", async () => {
    const owner = await insertOwner(db);
    const id = await add(owner, "Mine");
    const res = await request(app)
      .post(`/api/notifications/${id}/read`)
      .set("Cookie", cookieFor(owner, "owner"))
      .set("Origin", "https://elsewhere.example");
    expect(res.status).toBe(403);
    expect(await readAt(id)).toBeNull();
  });
});

describe("POST /api/notifications/read-all", () => {
  it("marks all of the caller's unread notifications read and says how many", async () => {
    const owner = await insertOwner(db);
    const someoneElse = await insertOwner(db);
    await add(owner, "One");
    await add(owner, "Two");
    const theirs = await add(someoneElse, "Theirs");

    const res = await request(app).post("/api/notifications/read-all").set("Cookie", cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ marked: 2 });
    expect(await readAt(theirs)).toBeNull();
  });
});

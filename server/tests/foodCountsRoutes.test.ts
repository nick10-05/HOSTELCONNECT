import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// GET /api/food-counts?date=YYYY-MM-DD (day 8): the owner's food counts for a date, India's
// today when none is given. The counting rules are in tests/foodCounts.test.ts; here the
// route: who may ask, the date, and the answer. Committed test database; the app's clock
// is fixed at 2032-06-14 19:00 UTC, which is already 15 June in India.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("2032-06-14T19:00:00Z");
const app = () => createApp({ db, jwtSecret: SECRET, clock: () => NOW });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

// A building with one veg student and one non-veg student who eats veg on Tuesdays,
// both staying from 1 June 2032 to 20 June 2032 (not included).
async function building(): Promise<number> {
  const owner = await insertOwner(db);
  const { rows } = await db.query<{ id: number }>("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [
    `Food route ${randomUUID()}`,
  ]);
  for (const [food, vegDays] of [
    ["veg", []],
    ["non_veg", [2]],
  ] as const) {
    const student = await insertStudent(db);
    await db.query("UPDATE users SET food_preference = $2, veg_days = $3 WHERE id = $1", [student, food, vegDays]);
    await db.query(
      `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by)
       VALUES ($1, $2, '2032-06-01', '2032-06-20', $3)`,
      [student, rows[0].id, owner],
    );
  }
  return rows[0].id;
}

describe("GET /api/food-counts", () => {
  it("is for the owner only", async () => {
    expect((await request(app()).get("/api/food-counts")).status).toBe(401);
    const student = await request(app())
      .get("/api/food-counts")
      .set("Cookie", cookieFor(await insertStudent(db), "student"));
    expect(student.status).toBe(403);
    expect(student.body.error.code).toBe("forbidden");
  });

  it("counts for India's today when no date is given, and is never cached", async () => {
    const id = await building();
    const res = await request(app()).get("/api/food-counts").set("Cookie", cookieFor(await insertOwner(db), "owner"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // 15 June 2032 is a Tuesday: the non-veg student eats veg.
    expect(res.body).toMatchObject({ date: "2032-06-15", weekday: 2 });
    expect(res.body.buildings.find((b: { buildingId: number }) => b.buildingId === id)).toMatchObject({
      veg: 2,
      nonVeg: 0,
      total: 2,
    });
    expect(Object.keys(res.body.overall).sort()).toEqual(["nonVeg", "total", "veg"]);
  });

  it("counts for the date asked", async () => {
    const id = await building();
    const owner = cookieFor(await insertOwner(db), "owner");
    const row = async (date: string) => {
      const res = await request(app()).get(`/api/food-counts?date=${date}`).set("Cookie", owner);
      expect(res.status).toBe(200);
      expect(res.body.date).toBe(date);
      return res.body.buildings.find((b: { buildingId: number }) => b.buildingId === id);
    };
    expect(await row("2032-06-14")).toMatchObject({ veg: 1, nonVeg: 1, total: 2 }); // Monday
    expect(await row("2032-06-20")).toMatchObject({ veg: 0, nonVeg: 0, total: 0 }); // they left
  });

  it("refuses a date that is not a real YYYY-MM-DD date", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const date of ["2032-02-30", "15-06-2032", "today", "2032-6-1", ""]) {
      const res = await request(app()).get("/api/food-counts").query({ date }).set("Cookie", owner);
      expect(res.status, date).toBe(400);
      expect(res.body.error.code, date).toBe("invalid_input");
    }
  });
});

// The return-poll filter (day 9). Committed rows: the poll is closed, so it never blocks
// another file's open poll.
describe("GET /api/food-counts?pollId=", () => {
  it("counts only students who answered 'returned' to that poll", async () => {
    const id = await building();
    const owner = await insertOwner(db);
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO return_polls (title, created_by, status, closed_at) VALUES ('Back?', $1, 'closed', now()) RETURNING id`,
      [owner],
    );
    const poll = rows[0].id;
    const { rows: students } = await db.query<{ id: number }>(
      `SELECT student_id AS id FROM stays WHERE building_id = $1 ORDER BY student_id`,
      [id],
    );
    // Only the veg student (the first) says they are back.
    await db.query(`INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, 'returned')`, [
      poll,
      students[0].id,
    ]);

    const res = await request(app())
      .get(`/api/food-counts?date=2032-06-14&pollId=${poll}`)
      .set("Cookie", cookieFor(owner, "owner"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: "2032-06-14", pollId: poll });
    expect(res.body.buildings.find((b: { buildingId: number }) => b.buildingId === id)).toMatchObject({
      veg: 1,
      nonVeg: 0,
      total: 1,
    });
    expect(res.body.overall).toEqual({ veg: 1, nonVeg: 0, total: 1 });
  });

  it("answers pollId null without a poll", async () => {
    const res = await request(app()).get("/api/food-counts").set("Cookie", cookieFor(await insertOwner(db), "owner"));
    expect(res.body.pollId).toBeNull();
  });

  it("refuses a poll id that is not a positive whole number, and an unknown poll", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const pollId of ["abc", "0", "-1", "1.5", ""]) {
      const res = await request(app()).get("/api/food-counts").query({ pollId }).set("Cookie", owner);
      expect(res.status, pollId).toBe(400);
      expect(res.body.error.code, pollId).toBe("invalid_input");
    }
    const missing = await request(app()).get("/api/food-counts?pollId=999999999").set("Cookie", owner);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "poll_not_found", message: "That poll does not exist." } });
  });
});

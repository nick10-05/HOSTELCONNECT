import request from "supertest";
import { describe, afterAll, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { COMPLAINT_REFUSALS_PER_IP } from "../src/routes/complaints";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// The complaint routes through the real app, services and test database (section 8:
// "a student asking for someone else's complaint gets 404", "a third new complaint in a
// day gets 429"). Every test builds its own app, so each starts with fresh rate-limit
// counts: all requests here come from the same IP.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const newApp = (extra: Partial<AppDeps> = {}) => createApp({ db, jwtSecret: SECRET, ...extra });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

const TEXT = "The tap in room 101 keeps dripping all night.";
const ITEM_FIELDS = ["category", "createdAt", "description", "id", "resolvedAt", "status", "updatedAt"];
const NOT_FOUND = { error: { code: "complaint_not_found", message: "That complaint does not exist." } };

// An existing complaint, written straight to the table; two days old unless hoursAgo says.
async function addComplaint(
  student: number,
  category: string,
  opts: { status?: string; hoursAgo?: number } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at, created_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'resolved' THEN now() END, now() - $5::float8 * interval '1 hour')
     RETURNING id`,
    [student, category, TEXT, opts.status ?? "open", opts.hoursAgo ?? 48],
  );
  return rows[0].id;
}

const complaintsOf = async (student: number) =>
  (await db.query("SELECT id, category, description FROM complaints WHERE student_id = $1 ORDER BY id", [student]))
    .rows;

describe("who may use the complaint routes", () => {
  it("need a session", async () => {
    const app = newApp();
    expect((await request(app).post("/api/complaints").send({ category: "food", description: TEXT })).status).toBe(401);
    expect((await request(app).get("/api/complaints")).status).toBe(401);
    expect((await request(app).get("/api/complaints/1")).status).toBe(401);
  });

  it("are for students only until the owner's screens arrive on day 7", async () => {
    const app = newApp();
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const res of [
      await request(app).post("/api/complaints").set("Cookie", owner).send({ category: "food", description: TEXT }),
      await request(app).get("/api/complaints").set("Cookie", owner),
      await request(app).get("/api/complaints/1").set("Cookie", owner),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
  });

  it("are closed to a student who still has a temporary password, and to one who moved out", async () => {
    const app = newApp();
    const temporary = cookieFor(await insertStudent(db, { mustChangePassword: true }), "student");
    const res = await request(app).post("/api/complaints").set("Cookie", temporary).send({ category: "food", description: TEXT });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("password_change_required");

    const movedOut = await insertStudent(db, { isActive: false });
    const gone = await request(app)
      .post("/api/complaints")
      .set("Cookie", cookieFor(movedOut, "student"))
      .send({ category: "food", description: TEXT });
    expect(gone.status).toBe(401);
    expect(await complaintsOf(movedOut)).toEqual([]);
  });

  it("refuse a complaint sent from another site's page", async () => {
    const student = await insertStudent(db);
    const res = await request(newApp())
      .post("/api/complaints")
      .set("Cookie", cookieFor(student, "student"))
      .set("Origin", "https://elsewhere.example")
      .send({ category: "food", description: TEXT });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("cross_origin");
    expect(await complaintsOf(student)).toEqual([]);
  });
});

describe("POST /api/complaints", () => {
  it("creates the complaint and answers 201 with it and its timeline, without the priority", async () => {
    const student = await insertStudent(db);
    const res = await request(newApp())
      .post("/api/complaints")
      .set("Cookie", cookieFor(student, "student"))
      .send({ category: "electrical", description: "  The fan in room 204 does not turn on.\n" });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([...ITEM_FIELDS, "events"].sort());
    expect(res.body).toMatchObject({
      category: "electrical",
      description: "The fan in room 204 does not turn on.", // trimmed
      status: "open",
      resolvedAt: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(res.body.events).toEqual([
      { kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: expect.any(String) },
    ]);
    expect(await complaintsOf(student)).toEqual([
      { id: res.body.id, category: "electrical", description: "The fan in room 204 does not turn on." },
    ]);
  });

  it("always files the complaint as the signed-in student, whatever the body says", async () => {
    const student = await insertStudent(db);
    const someoneElse = await insertStudent(db);
    const res = await request(newApp())
      .post("/api/complaints")
      .set("Cookie", cookieFor(student, "student"))
      .send({ category: "food", description: TEXT, studentId: someoneElse, student_id: someoneElse, priority: "high" });

    expect(res.status).toBe(201);
    expect(await complaintsOf(someoneElse)).toEqual([]);
    const { rows } = await db.query("SELECT student_id, priority FROM complaints WHERE id = $1", [res.body.id]);
    expect(rows[0]).toEqual({ student_id: student, priority: "normal" });
  });

  it("refuses a bad category or description with 400 and creates nothing", async () => {
    const student = await insertStudent(db);
    const app = newApp();
    for (const body of [
      {},
      { description: TEXT },
      { category: "water", description: TEXT },
      { category: "food" },
      { category: "food", description: 42 },
      { category: "food", description: "Too short" }, // 9 characters
      { category: "food", description: `   ${"x".repeat(9)}   \n` }, // 9 once trimmed
      { category: "food", description: "          " },
      { category: "food", description: "x".repeat(501) },
      { category: "food", description: "😀😀😀😀😀" }, // 10 in JavaScript's count, 5 characters
      { category: "food", description: `${TEXT}\u0000` },
    ]) {
      const res = await request(app).post("/api/complaints").set("Cookie", cookieFor(student, "student")).send(body);
      expect(res.status, JSON.stringify(body).slice(0, 50)).toBe(400);
      expect(res.body.error.code).toBe("invalid_input");
    }
    expect(await complaintsOf(student)).toEqual([]);
  });

  it("accepts exactly 10 and exactly 500 characters, counted as the database counts them", async () => {
    const app = newApp({ complaintLimits: { maxActive: 10, maxNewPer24h: 10 } });
    const student = await insertStudent(db);
    const send = (category: string, description: string) =>
      request(app).post("/api/complaints").set("Cookie", cookieFor(student, "student")).send({ category, description });

    expect((await send("food", "x".repeat(10))).status).toBe(201);
    expect((await send("internet", "x".repeat(500))).status).toBe(201);
    expect((await send("security", "😀".repeat(500))).status).toBe(201);
    expect((await send("furniture", "😀".repeat(10))).status).toBe(201);
  });

  describe("each limit answers 429 with a message that says which", () => {
    it("one active complaint per category", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing");
      const res = await request(newApp())
        .post("/api/complaints")
        .set("Cookie", cookieFor(student, "student"))
        .send({ category: "plumbing", description: TEXT });
      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        error: {
          code: "category_active",
          message:
            "You already have an active plumbing complaint. You can raise another one when it is resolved or rejected.",
        },
      });
    });

    it("three active complaints", async () => {
      const student = await insertStudent(db);
      for (const category of ["plumbing", "electrical", "food"]) await addComplaint(student, category);
      const res = await request(newApp())
        .post("/api/complaints")
        .set("Cookie", cookieFor(student, "student"))
        .send({ category: "internet", description: TEXT });
      expect(res.status).toBe(429);
      expect(res.body.error).toEqual({
        code: "too_many_active",
        message: "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.",
      });
    });

    it("a third new complaint in 24 hours", async () => {
      const student = await insertStudent(db);
      const app = newApp();
      const send = (category: string) =>
        request(app).post("/api/complaints").set("Cookie", cookieFor(student, "student")).send({ category, description: TEXT });

      expect((await send("plumbing")).status).toBe(201);
      expect((await send("electrical")).status).toBe(201);
      const third = await send("food");
      expect(third.status).toBe(429);
      expect(third.body.error).toEqual({
        code: "too_many_recent",
        message: "You can raise at most 2 complaints in 24 hours. Please try again later.",
      });
      expect(await complaintsOf(student)).toHaveLength(2);
    });

    it("uses the limits the app was given", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing");
      const res = await request(newApp({ complaintLimits: { maxActive: 1, maxNewPer24h: 2 } }))
        .post("/api/complaints")
        .set("Cookie", cookieFor(student, "student"))
        .send({ category: "food", description: TEXT });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("too_many_active");
    });
  });

  describe("the per-IP limit", () => {
    it(`stops an IP after ${COMPLAINT_REFUSALS_PER_IP} refused requests in 15 minutes, even a valid one`, async () => {
      const app = newApp();
      const student = cookieFor(await insertStudent(db), "student");
      for (let i = 0; i < COMPLAINT_REFUSALS_PER_IP; i += 1) {
        const res = await request(app).post("/api/complaints").set("Cookie", student).send({ category: "food" });
        expect(res.status).toBe(400);
      }

      const fresh = await insertStudent(db);
      const res = await request(app)
        .post("/api/complaints")
        .set("Cookie", cookieFor(fresh, "student"))
        .send({ category: "food", description: TEXT });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("rate_limited");
      expect(await complaintsOf(fresh)).toEqual([]);
    });

    it("never counts accepted complaints, so many students on the hostel's Wi-Fi are not blocked", async () => {
      const app = newApp();
      for (let i = 0; i < COMPLAINT_REFUSALS_PER_IP + 5; i += 1) {
        const res = await request(app)
          .post("/api/complaints")
          .set("Cookie", cookieFor(await insertStudent(db), "student"))
          .send({ category: "food", description: TEXT });
        expect(res.status, `student ${i + 1}`).toBe(201);
      }
    });

    it("does not count reading", async () => {
      const app = newApp();
      const student = cookieFor(await insertStudent(db), "student");
      for (let i = 0; i < COMPLAINT_REFUSALS_PER_IP + 5; i += 1) {
        expect((await request(app).get("/api/complaints/999999999").set("Cookie", student)).status).toBe(404);
      }
      const res = await request(app).post("/api/complaints").set("Cookie", student).send({ category: "food", description: TEXT });
      expect(res.status).toBe(201);
    });
  });
});

describe("GET /api/complaints", () => {
  it("lists only the caller's own complaints, newest first, with exactly the student's fields", async () => {
    const student = await insertStudent(db);
    const other = await insertStudent(db);
    const older = await addComplaint(student, "food", { hoursAgo: 30 });
    const newer = await addComplaint(student, "internet", { hoursAgo: 2 });
    await addComplaint(other, "food");

    const res = await request(newApp()).get("/api/complaints").set("Cookie", cookieFor(student, "student"));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([newer, older]);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(ITEM_FIELDS);
  });

  it("pages, 20 by default and at most 50", async () => {
    const student = await insertStudent(db);
    const ids: number[] = [];
    for (const [category, hoursAgo] of [["food", 30], ["internet", 20], ["security", 10]] as const) {
      ids.push(await addComplaint(student, category, { status: "resolved", hoursAgo }));
    }
    const app = newApp();
    const get = (query: string) => request(app).get(`/api/complaints${query}`).set("Cookie", cookieFor(student, "student"));

    const page2 = await get("?page=2&limit=2");
    expect(page2.body).toMatchObject({ total: 3 });
    expect(page2.body.items.map((i: { id: number }) => i.id)).toEqual([ids[0]]);
    expect((await get("")).body.items).toHaveLength(3);
    for (const query of ["?limit=51", "?limit=0", "?page=0", "?page=abc"]) {
      expect((await get(query)).status, query).toBe(400);
    }
  });
});

describe("GET /api/complaints: can the student raise a complaint now?", () => {
  it("allows, and names the categories that already have an active complaint", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing");
    await addComplaint(student, "food", { status: "resolved" });

    const res = await request(newApp()).get("/api/complaints").set("Cookie", cookieFor(student, "student"));
    expect(res.body.canRaise).toEqual({ allowed: true, reason: null, activeCategories: ["plumbing"] });
  });

  it("refuses with the same message a new complaint would get, from the app's limits", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing");
    const app = newApp({ complaintLimits: { maxActive: 1, maxNewPer24h: 2 } });
    const cookie = cookieFor(student, "student");

    const list = await request(app).get("/api/complaints").set("Cookie", cookie);
    expect(list.body.canRaise.allowed).toBe(false);

    const create = await request(app).post("/api/complaints").set("Cookie", cookie).send({ category: "food", description: TEXT });
    expect(create.status).toBe(429);
    expect(list.body.canRaise.reason).toBe(create.body.error.message);
  });

  it("refuses after two new complaints in 24 hours", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing", { status: "resolved", hoursAgo: 2 });
    await addComplaint(student, "food", { status: "rejected", hoursAgo: 1 });

    const res = await request(newApp()).get("/api/complaints").set("Cookie", cookieFor(student, "student"));
    expect(res.body.canRaise).toEqual({
      allowed: false,
      reason: "You can raise at most 2 complaints in 24 hours. Please try again later.",
      activeCategories: [],
    });
  });
});

describe("GET /api/complaints/:id", () => {
  it("returns the caller's own complaint with its timeline", async () => {
    const student = await insertStudent(db);
    const app = newApp();
    const created = await request(app)
      .post("/api/complaints")
      .set("Cookie", cookieFor(student, "student"))
      .send({ category: "cleanliness", description: "The corridor bin has not been emptied since Monday." });

    const res = await request(app).get(`/api/complaints/${created.body.id}`).set("Cookie", cookieFor(student, "student"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  it("answers another student's complaint with exactly the same 404 as one that does not exist", async () => {
    const raiser = await insertStudent(db);
    const other = cookieFor(await insertStudent(db), "student");
    const id = await addComplaint(raiser, "food");
    await db.query("UPDATE complaints SET priority = 'high' WHERE id = $1", [id]);
    const app = newApp();

    const notYours = await request(app).get(`/api/complaints/${id}`).set("Cookie", other);
    const missing = await request(app).get("/api/complaints/999999999").set("Cookie", other);

    expect(notYours.status).toBe(404);
    expect(notYours.body).toEqual(NOT_FOUND);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(notYours.body);
    // The student who raised it still reads it, and still without the priority.
    const own = await request(app).get(`/api/complaints/${id}`).set("Cookie", cookieFor(raiser, "student"));
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty("priority");
  });

  it("answers an id that is not a whole number with a plain 404", async () => {
    const student = cookieFor(await insertStudent(db), "student");
    for (const id of ["abc", "0", "-1", "1.5"]) {
      const res = await request(newApp()).get(`/api/complaints/${id}`).set("Cookie", student);
      expect(res.status, id).toBe(404);
    }
  });
});

import request from "supertest";
import { describe, afterAll, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { COMPLAINT_REFUSALS_PER_IP } from "../src/routes/complaints";
import { insertOwner, insertStructure, insertStudent, testPool } from "./helpers/db";

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

  it("let only students raise a complaint; the owner reads them (day 7)", async () => {
    const app = newApp();
    const owner = cookieFor(await insertOwner(db), "owner");
    const res = await request(app).post("/api/complaints").set("Cookie", owner).send({ category: "food", description: TEXT });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect((await request(app).get("/api/complaints").set("Cookie", owner)).status).toBe(200);
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

// ---- The owner's side (day 7) ----
// Rows here are committed, so each test makes its own building and asks for it only.

const OWNER_ITEM_FIELDS = [...ITEM_FIELDS, "place", "priority", "student"].sort();
// insertStudent gives every student these numbers; neither may appear in an answer.
const PHONES = ["9000000000", "9000000001"];

// A student living in room 101 of a new building of their own.
async function resident(name: string) {
  const place = await insertStructure(db);
  const student = await insertStudent(db);
  await db.query("UPDATE users SET name = $2 WHERE id = $1", [student, name]);
  await db.query(
    `INSERT INTO stays (student_id, building_id, room_id, started_on, created_by)
     VALUES ($1, $2, $3, '2026-01-14', $4)`,
    [student, place.building, place.room, await insertOwner(db)],
  );
  return { student, ...place };
}

describe("GET /api/complaints as the owner", () => {
  it("lists every student's complaints in section 5's order, with the owner's fields and no phone numbers", async () => {
    const r = await resident("Meera Iyer");
    const normal = await addComplaint(r.student, "food", { hoursAgo: 50 });
    const high = await addComplaint(r.student, "plumbing", { hoursAgo: 2 });
    await db.query("UPDATE complaints SET priority = 'high' WHERE id = $1", [high]);
    const owner = cookieFor(await insertOwner(db), "owner");

    const res = await request(newApp()).get(`/api/complaints?buildingId=${r.building}`).set("Cookie", owner);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["items", "total"]); // no canRaise
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([high, normal]);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(OWNER_ITEM_FIELDS);
    expect(res.body.items[0]).toMatchObject({
      priority: "high",
      student: { id: r.student, name: "Meera Iyer", isActive: true },
      place: { buildingName: r.buildingName, roomNumber: "101" },
    });
    for (const phone of PHONES) expect(res.text).not.toContain(phone);
  });

  it("passes each filter from the query string", async () => {
    const r = await resident("Filter Student");
    const open = await addComplaint(r.student, "food", { hoursAgo: 2 });
    const resolved = await addComplaint(r.student, "internet", { status: "resolved", hoursAgo: 2 });
    const owner = cookieFor(await insertOwner(db), "owner");
    const app = newApp();
    const ids = async (query: string) => {
      const res = await request(app).get(`/api/complaints?buildingId=${r.building}&${query}`).set("Cookie", owner);
      expect(res.status, query).toBe(200);
      return res.body.items.map((i: { id: number }) => i.id);
    };

    expect(await ids("status=resolved")).toEqual([resolved]);
    expect(await ids("priority=normal&category=food")).toEqual([open]);
    expect(await ids("priority=high")).toEqual([]);
    expect(await ids("from=2000-01-01&to=2999-12-31")).toEqual([open, resolved]);
    expect(await ids("to=2000-01-01")).toEqual([]);
    expect(await ids("limit=1&page=2")).toEqual([resolved]);
  });

  it("refuses a bad filter with 400", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    const app = newApp();
    for (const query of [
      "status=closed",
      "status=",
      "priority=urgent",
      "category=noise",
      "buildingId=0",
      "buildingId=abc",
      "from=2026-02-30",
      "from=01-11-2026",
      "to=yesterday",
      "from=2026-11-02&to=2026-11-01",
      "page=0",
      "limit=51",
    ]) {
      const res = await request(app).get(`/api/complaints?${query}`).set("Cookie", owner);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe("invalid_input");
    }
    // The same day at both ends is fine.
    expect((await request(app).get("/api/complaints?from=2026-11-01&to=2026-11-01").set("Cookie", owner)).status).toBe(200);
  });

  it("leaves the student's list as it was: own complaints, canRaise, no priority, owner filters ignored", async () => {
    const student = await insertStudent(db);
    const open = await addComplaint(student, "food", { hoursAgo: 2 });
    const resolved = await addComplaint(student, "internet", { status: "resolved", hoursAgo: 1 });

    const res = await request(newApp())
      .get("/api/complaints?status=resolved&buildingId=1")
      .set("Cookie", cookieFor(student, "student"));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["canRaise", "items", "total"]);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([resolved, open]);
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(ITEM_FIELDS);
  });
});

describe("GET /api/complaints/:id as the owner", () => {
  it("returns any student's complaint with its priority, timeline and allowed moves, and no phone numbers", async () => {
    const r = await resident("Kiran Das");
    const app = newApp();
    const created = await request(app)
      .post("/api/complaints")
      .set("Cookie", cookieFor(r.student, "student"))
      .send({ category: "furniture", description: "The cupboard door in room 101 is broken." });
    const owner = cookieFor(await insertOwner(db), "owner");

    const res = await request(app).get(`/api/complaints/${created.body.id}`).set("Cookie", owner);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual([...OWNER_ITEM_FIELDS, "allowedMoves", "events"].sort());
    expect(res.body).toMatchObject({
      id: created.body.id,
      status: "open",
      priority: "normal",
      student: { id: r.student, name: "Kiran Das", isActive: true },
      place: { buildingName: r.buildingName, roomNumber: "101" },
      events: created.body.events,
    });
    expect([...res.body.allowedMoves].sort()).toEqual(["in_progress", "rejected", "resolved"]);
    for (const phone of PHONES) expect(res.text).not.toContain(phone);
  });

  it("answers a missing id with the usual 404, and a non-number id with a plain 404", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    const app = newApp();
    const missing = await request(app).get("/api/complaints/999999999").set("Cookie", owner);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(NOT_FOUND);
    expect((await request(app).get("/api/complaints/abc").set("Cookie", owner)).status).toBe(404);
  });
});

// ---- The owner's writes (day 7): status, priority, notes ----

// The complaint's row, its timeline and the student's bell, to show what a request wrote.
async function writtenFor(id: number, student: number) {
  const complaint = (
    await db.query(
      `SELECT status, priority, resolved_at AS "resolvedAt", updated_at AS "updatedAt" FROM complaints WHERE id = $1`,
      [id],
    )
  ).rows[0];
  const events = (
    await db.query(
      `SELECT kind, from_status AS "from", to_status AS "to", note FROM complaint_events WHERE complaint_id = $1 ORDER BY id`,
      [id],
    )
  ).rows;
  const notifications = (
    await db.query("SELECT type, title, body, link FROM notifications WHERE user_id = $1 ORDER BY id", [student])
  ).rows;
  return { complaint, events, notifications };
}

// The three writes on one complaint, each with a body that would succeed for the owner.
const WRITES = [
  { method: "post", path: (id: number) => `/api/complaints/${id}/status`, body: { from: "open", to: "in_progress" } },
  { method: "patch", path: (id: number) => `/api/complaints/${id}`, body: { priority: "high" } },
  { method: "post", path: (id: number) => `/api/complaints/${id}/notes`, body: { note: "Plumber booked." } },
] as const;

const send = (app: ReturnType<typeof newApp>, w: (typeof WRITES)[number], id: number) =>
  w.method === "post" ? request(app).post(w.path(id)) : request(app).patch(w.path(id));

describe("the owner's complaint writes: who may call them", () => {
  it("need a session", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const before = await writtenFor(id, student);
    for (const w of WRITES) {
      const res = await send(newApp(), w, id).send(w.body);
      expect(res.status, w.path(id)).toBe(401);
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });

  it("refuse a student, even the one who raised the complaint, and write nothing", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const before = await writtenFor(id, student);
    for (const w of WRITES) {
      const res = await send(newApp(), w, id).set("Cookie", cookieFor(student, "student")).send(w.body);
      expect(res.status, w.path(id)).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });

  it("refuse an owner who still has a temporary password", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const owner = cookieFor(await insertOwner(db, { mustChangePassword: true }), "owner");
    for (const w of WRITES) {
      const res = await send(newApp(), w, id).set("Cookie", owner).send(w.body);
      expect(res.status, w.path(id)).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");
    }
  });

  it("refuse a write sent from another site's page", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const before = await writtenFor(id, student);
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const w of WRITES) {
      const res = await send(newApp(), w, id).set("Cookie", owner).set("Origin", "https://elsewhere.example").send(w.body);
      expect(res.status, w.path(id)).toBe(403);
      expect(res.body.error.code).toBe("cross_origin");
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });

  it("answer a missing complaint with the usual 404, and a non-number id with a plain 404", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const w of WRITES) {
      const missing = await send(newApp(), w, 999_999_999).set("Cookie", owner).send(w.body);
      expect(missing.status, w.path(999_999_999)).toBe(404);
      expect(missing.body).toEqual(NOT_FOUND);
    }
    const app = newApp();
    expect((await request(app).post("/api/complaints/abc/status").set("Cookie", owner).send(WRITES[0].body)).status).toBe(404);
    expect((await request(app).patch("/api/complaints/0").set("Cookie", owner).send(WRITES[1].body)).status).toBe(404);
    expect((await request(app).post("/api/complaints/-1/notes").set("Cookie", owner).send(WRITES[2].body)).status).toBe(404);
  });
});

describe("POST /api/complaints/:id/status", () => {
  it("changes the status, writes the event, notifies the student, and answers with the owner's view", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "plumbing");
    const owner = cookieFor(await insertOwner(db), "owner");

    const res = await request(newApp())
      .post(`/api/complaints/${id}/status`)
      .set("Cookie", owner)
      .send({ from: "open", to: "rejected", note: "  Duplicate of #41.  " });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual([...OWNER_ITEM_FIELDS, "allowedMoves", "events"].sort());
    expect(res.body).toMatchObject({ id, status: "rejected", allowedMoves: [] });
    const written = await writtenFor(id, student);
    expect(written.events).toEqual([{ kind: "status_change", from: "open", to: "rejected", note: "Duplicate of #41." }]);
    expect(written.notifications).toEqual([
      { type: "complaint_update", title: "Your plumbing complaint is now rejected.", body: null, link: `/complaints/${id}` },
    ]);
  });

  it("passes the service's refusals through unchanged, and writes nothing", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food", { status: "in_progress" });
    const owner = cookieFor(await insertOwner(db), "owner");
    const before = await writtenFor(id, student);
    const change = (body: object) => request(newApp()).post(`/api/complaints/${id}/status`).set("Cookie", owner).send(body);

    const illegal = await change({ from: "in_progress", to: "open" });
    expect(illegal.status).toBe(409);
    expect(illegal.body).toEqual({
      error: { code: "illegal_transition", message: "A complaint that is in progress cannot be moved to open." },
    });

    const noNote = await change({ from: "in_progress", to: "rejected", note: "   " });
    expect(noNote.status).toBe(400);
    expect(noNote.body).toEqual({ error: { code: "note_required", message: "Rejecting a complaint needs a note." } });

    const stale = await change({ from: "open", to: "resolved" });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: {
        code: "status_changed",
        message: "This complaint has changed since you opened it. Reload it and try again.",
      },
    });

    expect(await writtenFor(id, student)).toEqual(before);
  });

  it("refuses a body of the wrong shape with 400 invalid_input", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const owner = cookieFor(await insertOwner(db), "owner");
    const before = await writtenFor(id, student);
    for (const body of [
      {},
      { to: "resolved" },
      { from: "open" },
      { from: "open", to: "closed" },
      { from: "pending", to: "resolved" },
      { from: "open", to: "resolved", note: 42 },
      { from: "open", to: "resolved", note: "bad \u0000 note" },
    ]) {
      const res = await request(newApp()).post(`/api/complaints/${id}/status`).set("Cookie", owner).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code, JSON.stringify(body)).toBe("invalid_input");
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });

  it("accepts a null or missing note on a move that needs none", async () => {
    const owner = cookieFor(await insertOwner(db), "owner");
    for (const body of [{ from: "open", to: "in_progress" }, { from: "open", to: "in_progress", note: null }]) {
      const id = await addComplaint(await insertStudent(db), "food");
      const res = await request(newApp()).post(`/api/complaints/${id}/status`).set("Cookie", owner).send(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.status).toBe("in_progress");
    }
  });
});

describe("PATCH /api/complaints/:id", () => {
  it("sets the priority, and answers with the owner's view", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const owner = cookieFor(await insertOwner(db), "owner");
    const before = await writtenFor(id, student);

    const res = await request(newApp()).patch(`/api/complaints/${id}`).set("Cookie", owner).send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ id, priority: "high", status: "open" });
    const after = await writtenFor(id, student);
    expect(after.complaint).toEqual({ ...before.complaint, priority: "high" });
    expect(after.events).toEqual([]);
    expect(after.notifications).toEqual([]);
  });

  it("accepts only a priority: a bad value or any other field is 400, and nothing changes", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const owner = cookieFor(await insertOwner(db), "owner");
    const before = await writtenFor(id, student);
    for (const body of [
      {},
      { priority: "urgent" },
      { priority: null },
      { status: "resolved" },
      { priority: "high", status: "resolved" },
      { priority: "high", description: "Rewritten by the owner." },
    ]) {
      const res = await request(newApp()).patch(`/api/complaints/${id}`).set("Cookie", owner).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code, JSON.stringify(body)).toBe("invalid_input");
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });
});

describe("POST /api/complaints/:id/notes", () => {
  it("adds the note, notifies the student, and answers with the owner's view", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "internet", { status: "resolved" });
    const owner = cookieFor(await insertOwner(db), "owner");

    const res = await request(newApp())
      .post(`/api/complaints/${id}/notes`)
      .set("Cookie", owner)
      .send({ note: " Router replaced on Friday. " });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ id, status: "resolved" });
    expect(res.body.events.map((e: { note: string }) => e.note)).toEqual(["Router replaced on Friday."]);
    const written = await writtenFor(id, student);
    expect(written.events).toEqual([{ kind: "note", from: null, to: null, note: "Router replaced on Friday." }]);
    expect(written.notifications).toEqual([
      {
        type: "complaint_update",
        title: "There is a new note on your internet complaint.",
        body: null,
        link: `/complaints/${id}`,
      },
    ]);
  });

  it("passes the service's note refusals through unchanged, and refuses a body of the wrong shape", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food");
    const owner = cookieFor(await insertOwner(db), "owner");
    const before = await writtenFor(id, student);
    const add = (body: object) => request(newApp()).post(`/api/complaints/${id}/notes`).set("Cookie", owner).send(body);

    const blank = await add({ note: " \n " });
    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ error: { code: "note_required", message: "A note cannot be empty." } });

    const long = await add({ note: "a".repeat(501) });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: { code: "note_too_long", message: "A note can be at most 500 characters." } });

    for (const body of [{}, { note: null }, { note: 7 }, { note: "bad \u0000 note" }]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code, JSON.stringify(body)).toBe("invalid_input");
    }
    expect(await writtenFor(id, student)).toEqual(before);
  });
});

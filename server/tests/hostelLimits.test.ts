import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { markHostel, withHostel } from "../src/db";
import { hostelToday } from "../src/lib/dates";
import { signSession } from "../src/lib/token";
import { requireStudentPlace } from "../src/services/hostels";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Each hostel's limits (multi-tenant phase 5a): current students and buildings, counted
// per hostel, checked whenever a student becomes current or a building is added. The
// limits are the platform admin's (the app cannot change them), so each test's hostel is
// made with the migration credential, with small limits.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
const app = createApp({ db, jwtSecret: SECRET });
afterAll(() => db.end());

async function asAdmin<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    return (await admin.query<T>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

const cookieOf = (userId: number, role: "owner" | "student") => `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

// A hostel with these limits, its owner (signed in), and one building with a room and a bed.
async function hostelWith(limits: { students: number; buildings: number }) {
  const [{ id }] = await asAdmin<{ id: number }>(
    "INSERT INTO hostels (name, student_limit, building_limit) VALUES ($1, $2, $3) RETURNING id::int",
    [`Limits ${randomUUID().slice(0, 8)}`, limits.students, limits.buildings],
  );
  const ids = await withHostel(db, id, async (tx) => {
    const owner = await insertOwner(tx);
    const building = (await tx.query<{ id: number }>("INSERT INTO buildings (name) VALUES ('Main') RETURNING id::int")).rows[0].id;
    return { owner, building };
  });
  return { id, ...ids, owner: cookieOf(ids.owner, "owner") };
}

const admission = (buildingId: number) => ({
  name: "Ravi Kumar",
  email: `limit-${randomUUID()}@test.local`,
  phone: "9123456780",
  parentPhone: "9123456781",
  category: "other",
  joiningDate: hostelToday(),
  foodPreference: "veg",
  buildingId,
});

const currentStudents = async (hostel: number) =>
  (await asAdmin<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE hostel_id = $1 AND role = 'student' AND is_active", [hostel]))[0].n;

const formerStudent = (hostel: number) => withHostel(db, hostel, (tx) => insertStudent(tx, { isActive: false }));

describe("the student limit", () => {
  it("admits up to the limit, then refuses with what to do, writing nothing", async () => {
    const h = await hostelWith({ students: 2, buildings: 5 });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building))).status).toBe(201);
    }
    const third = await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building));
    expect([third.status, third.body.error.code]).toEqual([409, "student_limit_reached"]);
    expect(third.body.error.message).toMatch(/limit of 2 current students/);
    expect(await currentStudents(h.id)).toBe(2);
  });

  it("counts current students only: former students leave room", async () => {
    const h = await hostelWith({ students: 1, buildings: 5 });
    await formerStudent(h.id);
    await formerStudent(h.id);
    expect((await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building))).status).toBe(201);
    const next = await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building));
    expect(next.body.error.message).toMatch(/limit of 1 current student\./);
  });

  it("counts each hostel on its own", async () => {
    const full = await hostelWith({ students: 1, buildings: 5 });
    const other = await hostelWith({ students: 1, buildings: 5 });
    expect((await request(app).post("/api/students").set("Cookie", full.owner).send(admission(full.building))).status).toBe(201);
    expect((await request(app).post("/api/students").set("Cookie", other.owner).send(admission(other.building))).status).toBe(201);
    expect((await request(app).post("/api/students").set("Cookie", full.owner).send(admission(full.building))).status).toBe(409);
  });

  it("also stops a former student coming back, by reactivation or by an approved request", async () => {
    const h = await hostelWith({ students: 1, buildings: 5 });
    expect((await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building))).status).toBe(201);
    const former = await formerStudent(h.id);
    const place = { joiningDate: hostelToday(), buildingId: h.building };

    const back = await request(app).post(`/api/students/${former}/reactivate`).set("Cookie", h.owner).send(place);
    expect([back.status, back.body.error?.code]).toEqual([409, "student_limit_reached"]);

    const [{ id: requestId }] = await asAdmin<{ id: number }>(
      "INSERT INTO rejoin_requests (hostel_id, student_id, message) VALUES ($1, $2, 'Back please') RETURNING id::int",
      [h.id, former],
    );
    const approved = await request(app).post(`/api/rejoin-requests/${requestId}/approve`).set("Cookie", h.owner).send(place);
    expect([approved.status, approved.body.error?.code]).toEqual([409, "student_limit_reached"]);
    expect(await currentStudents(h.id)).toBe(1);
    const [req] = await asAdmin<{ status: string }>("SELECT status FROM rejoin_requests WHERE id = $1", [requestId]);
    expect(req.status).toBe("pending");
  });

  it("makes a second admission wait for the first, then counts it", async () => {
    const h = await hostelWith({ students: 1, buildings: 5 });
    const first = await db.connect();
    try {
      await first.query("BEGIN");
      await markHostel(first, h.id);
      await requireStudentPlace(first);
      await insertStudent(first);

      let settled = false;
      const second = withHostel(db, h.id, (tx) => requireStudentPlace(tx)).finally(() => {
        settled = true;
      });
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting for the hostel's lock

      await first.query("COMMIT");
      await expect(second).rejects.toMatchObject({ code: "student_limit_reached" });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
    }
  });

  it("lets only one of two admissions at once take the last place", async () => {
    const h = await hostelWith({ students: 1, buildings: 5 });
    const results = await Promise.all(
      [0, 1].map(() => request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await currentStudents(h.id)).toBe(1);
  });
});

describe("the building limit", () => {
  it("adds buildings up to the limit, then refuses", async () => {
    const h = await hostelWith({ students: 5, buildings: 2 });
    expect((await request(app).post("/api/buildings").set("Cookie", h.owner).send({ name: "Second" })).status).toBe(201);
    const third = await request(app).post("/api/buildings").set("Cookie", h.owner).send({ name: "Third" });
    expect([third.status, third.body.error.code]).toEqual([409, "building_limit_reached"]);
    expect(third.body.error.message).toMatch(/limit of 2 buildings\./);
    const [{ n }] = await asAdmin<{ n: number }>("SELECT count(*)::int AS n FROM buildings WHERE hostel_id = $1", [h.id]);
    expect(n).toBe(2);
  });
});

describe("GET /api/hostel", () => {
  it("gives the owner the hostel's settings, its limits and how much of them is used", async () => {
    const h = await hostelWith({ students: 7, buildings: 3 });
    await formerStudent(h.id);
    expect((await request(app).post("/api/students").set("Cookie", h.owner).send(admission(h.building))).status).toBe(201);
    const res = await request(app).get("/api/hostel").set("Cookie", h.owner);
    expect(res.status).toBe(200);
    expect(res.body.hostel).toMatchObject({
      slug: null,
      feesStartDate: null,
      limits: { students: 7, buildings: 3 },
      usage: { students: 1, buildings: 1 },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is for owners", async () => {
    const h = await hostelWith({ students: 5, buildings: 5 });
    const student = await withHostel(db, h.id, (tx) => insertStudent(tx, { mustChangePassword: false }));
    expect((await request(app).get("/api/hostel").set("Cookie", cookieOf(student, "student"))).status).toBe(403);
    expect((await request(app).get("/api/hostel")).status).toBe(401);
  });
});

describe("the fees start date", () => {
  it("is set and changed by the owner, never removed", async () => {
    const h = await hostelWith({ students: 5, buildings: 5 });
    const set = await request(app).patch("/api/hostel").set("Cookie", h.owner).send({ feesStartDate: "2026-12-01" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await request(app).get("/api/hostel").set("Cookie", h.owner)).body.hostel.feesStartDate).toBe("2026-12-01");

    expect((await request(app).patch("/api/hostel").set("Cookie", h.owner).send({ feesStartDate: "2026-11-15" })).status).toBe(200);
    for (const feesStartDate of [null, "", "2026-02-30", "15-11-2026", "2019-12-31", "2999-01-01"]) {
      const res = await request(app).patch("/api/hostel").set("Cookie", h.owner).send({ feesStartDate });
      expect(res.status, String(feesStartDate)).toBe(400);
    }
    // A name change leaves the date alone.
    expect((await request(app).patch("/api/hostel").set("Cookie", h.owner).send({ name: "Renamed" })).status).toBe(200);
    const [row] = await asAdmin<{ d: string }>("SELECT to_char(fees_start_date, 'YYYY-MM-DD') AS d FROM hostels WHERE id = $1", [h.id]);
    expect(row.d).toBe("2026-11-15");
  });
});

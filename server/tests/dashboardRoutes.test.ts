import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { fakeStorage } from "./helpers/fakeStorage";

// GET /api/dashboard through the real app and database. The numbers themselves are
// tests/dashboard.test.ts's and tests/usage.test.ts's job; here: who may ask, the
// answer's shape, and no caching. The usage card's clock is in February 2005, an egress
// month no other test touches.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("2005-02-10T06:00:00Z");
const MB = 1024 * 1024;
const newApp = (extra: Partial<AppDeps> = {}) => createApp({ db, jwtSecret: SECRET, clock: () => NOW, ...extra });
const app = newApp();
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

describe("GET /api/dashboard", () => {
  it("is for the owner only", async () => {
    expect((await request(app).get("/api/dashboard")).status).toBe(401);
    const student = await insertStudent(db);
    expect((await request(app).get("/api/dashboard").set("Cookie", cookieFor(student, "student"))).status).toBe(403);
  });

  it("answers every card, never cached", async () => {
    const owner = await insertOwner(db);
    const res = await request(app).get("/api/dashboard").set("Cookie", cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      students: { total: expect.any(Number), joiningLater: expect.any(Number), buildings: expect.any(Array) },
      rejoinRequests: { pending: expect.any(Number), oldestRequestedOn: expect.toBeOneOf([null, expect.any(String)]) },
      complaints: {
        active: expect.any(Number),
        highPriority: expect.any(Number),
        oldestActiveAt: expect.toBeOneOf([null, expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)]),
      },
      // Day 9: the return poll (null while none is open) and fees cards.
      returnPoll: expect.toBeOneOf([
        null,
        {
          id: expect.any(Number),
          title: expect.any(String),
          createdAt: expect.any(String),
          counts: { returned: expect.any(Number), notYet: expect.any(Number), noResponse: expect.any(Number) },
        },
      ]),
      fees: {
        dueSoon: { count: expect.any(Number), amount: expect.any(Number) },
        overdue: { count: expect.any(Number), amount: expect.any(Number) },
        pendingThisMonth: { count: expect.any(Number), amount: expect.any(Number) },
      },
      // Day 8: the storage and bandwidth card.
      usage: {
        storage: { usedBytes: expect.any(Number), limitBytes: 450 * MB, percent: expect.any(Number) },
        hostelStorage: { usedBytes: expect.any(Number), limitBytes: expect.any(Number), percent: expect.any(Number) },
        egress: { month: "2005-02", usedBytes: expect.any(Number), limitBytes: 3000 * MB, percent: expect.any(Number) },
        level: expect.toBeOneOf(["ok", "amber", "uploads_off"]),
        uploadsAllowed: expect.any(Boolean),
        failingDeletions: expect.any(Number),
        photosConfigured: false,
      },
    });
  });
});

describe("GET /api/dashboard: the storage and bandwidth card (day 8)", () => {
  // Storage is shared by every test file's photos, so its limit is set out of reach here
  // and the egress counter of February 2005 decides the level.
  const usageOf = async (egressMb: number, extra: Partial<AppDeps> = {}) => {
    await db.query(
      `INSERT INTO usage_counters (key, value) VALUES ('egress:2005-02', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [Math.round(egressMb * MB)],
    );
    const owner = cookieFor(await insertOwner(db), "owner");
    const res = await request(
      newApp({ storage: fakeStorage(), usageLimits: { storageLimitMb: 1_000_000, egressLimitMb: 100 }, ...extra }),
    )
      .get("/api/dashboard")
      .set("Cookie", owner);
    expect(res.status).toBe(200);
    return res.body.usage;
  };

  it("passes on the usage guard's level and numbers, with the configured limits", async () => {
    expect(await usageOf(10)).toMatchObject({
      egress: { month: "2005-02", usedBytes: 10 * MB, limitBytes: 100 * MB, percent: 10 },
      level: "ok",
      uploadsAllowed: true,
      photosConfigured: true,
    });
    expect(await usageOf(70)).toMatchObject({ egress: { percent: 70 }, level: "amber", uploadsAllowed: true });
    expect(await usageOf(85)).toMatchObject({ egress: { percent: 85 }, level: "uploads_off", uploadsAllowed: false });
  });

  it("says when photo storage is not set up at all", async () => {
    expect(await usageOf(10, { storage: null })).toMatchObject({ photosConfigured: false, level: "ok" });
  });
});

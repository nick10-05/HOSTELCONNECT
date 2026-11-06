import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { newPhotoPath } from "../src/lib/storage";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { fakeStorage, type FakeStorage } from "./helpers/fakeStorage";
import { rollbackDb } from "./helpers/rollbackDb";

// POST /api/internal/run-jobs (design doc, sections 5, 8 and 10): called every hour by
// GitHub Actions with a secret header; it runs the expire-photos job (day 8) and the
// fee-rows job (day 9, only when FEES_START_DATE is set). Each
// test builds its own app (the rate limit lives in the app) on rollbackDb, with a clock
// fixed in 1999, so the job sees this test's photos only and everything is rolled back.
const db = testPool();
afterAll(() => db.end());

const SECRET = "test-secret-that-is-at-least-32-characters";
const JOB_SECRET = "job-secret-for-tests-" + "j".repeat(20);
const NOW = new Date("1999-02-10T06:30:00Z");
const PATH = "/api/internal/run-jobs";

type Ctx = { c: PoolClient; storage: FakeStorage; app: ReturnType<typeof createApp> };

function withApp(deps: Partial<AppDeps>, fn: (ctx: Ctx) => Promise<void>) {
  return inRollback(db, async (c) => {
    const storage = fakeStorage();
    const app = createApp({
      db: rollbackDb(c),
      jwtSecret: SECRET,
      jobSecret: JOB_SECRET,
      storage,
      clock: () => NOW,
      ...deps,
    });
    await fn({ c, storage, app });
  });
}

// A complaint whose photo expired an hour before NOW.
async function duePhoto(c: PoolClient, storage: FakeStorage) {
  const path = newPhotoPath("image/webp");
  await storage.upload(path, new Uint8Array([1, 2, 3]), "image/webp");
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes, photo_expires_at)
     VALUES ($1, 'cleanliness', 'The corridor has not been swept for three days.', $2, 3, $3)
     RETURNING id`,
    [await insertStudent(c), path, new Date(NOW.getTime() - 3_600_000)],
  );
  return { id: rows[0].id, path };
}

const deletedAt = async (c: PoolClient, id: number) =>
  (await c.query("SELECT photo_deleted_at AS at FROM complaints WHERE id = $1", [id])).rows[0].at;

describe("POST /api/internal/run-jobs", () => {
  it("runs the expire-photos job with the right secret and answers what it did", () =>
    withApp({}, async ({ c, storage, app }) => {
      const photo = await duePhoto(c, storage);
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expirePhotos: { deleted: 1, failed: 0 }, feeRows: null });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(storage.objects.has(photo.path)).toBe(false);
      expect(await deletedAt(c, photo.id)).toEqual(NOW);
    }));

  it("refuses a missing or wrong secret with 401 and runs nothing", () =>
    withApp({}, async ({ c, storage, app }) => {
      const photo = await duePhoto(c, storage);
      // (Spaces around a header value are not part of it in HTTP, so they are not tried.)
      for (const header of [undefined, "", "wrong", JOB_SECRET.slice(0, -1), `${JOB_SECRET}x`, JOB_SECRET.toUpperCase()]) {
        const req = request(app).post(PATH);
        const res = await (header === undefined ? req : req.set("X-Job-Secret", header));
        expect(res.status, JSON.stringify(header)).toBe(401);
        expect(res.body).toEqual({ error: { code: "invalid_job_secret", message: "Not allowed." } });
      }
      // The secret in another header, or as a query, does not count either.
      expect((await request(app).post(PATH).set("Authorization", `Bearer ${JOB_SECRET}`)).status).toBe(401);
      expect((await request(app).post(`${PATH}?secret=${JOB_SECRET}`)).status).toBe(401);

      expect(storage.calls.filter((call) => call.operation === "remove")).toEqual([]);
      expect(await deletedAt(c, photo.id)).toBeNull();
    }));

  it("is not a session route: a logged-in owner or student without the secret gets 401", () =>
    withApp({}, async ({ c, app }) => {
      for (const [id, role] of [
        [await insertOwner(c), "owner"],
        [await insertStudent(c), "student"],
      ] as const) {
        const cookie = `${SESSION_COOKIE}=${signSession({ userId: id, role }, SECRET)}`;
        expect((await request(app).post(PATH).set("Cookie", cookie)).status).toBe(401);
      }
    }));

  it("does not exist without a JOB_SECRET (local development)", () =>
    withApp({ jobSecret: undefined }, async ({ c, storage, app }) => {
      const photo = await duePhoto(c, storage);
      for (const header of [undefined, "", JOB_SECRET]) {
        const req = request(app).post(PATH);
        const res = await (header === undefined ? req : req.set("X-Job-Secret", header));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: { code: "not_found", message: "No such endpoint" } });
      }
      expect(await deletedAt(c, photo.id)).toBeNull();
    }));

  it("answers only POST", () =>
    withApp({}, async ({ app }) => {
      expect((await request(app).get(PATH).set("X-Job-Secret", JOB_SECRET)).status).toBe(404);
      expect((await request(app).put(PATH).set("X-Job-Secret", JOB_SECRET)).status).toBe(404);
    }));

  it("takes a call with no Origin (GitHub Actions) but refuses one from another site", () =>
    withApp({}, async ({ app }) => {
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET).set("Origin", "https://evil.example");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("cross_origin");
      expect((await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET)).status).toBe(200);
    }));

  it("runs with nothing to do when photo uploads are off", () =>
    withApp({ storage: null }, async ({ app }) => {
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expirePhotos: { deleted: 0, failed: 0 }, feeRows: null });
    }));

  it("takes at most 10 calls per 15 minutes from all callers together, right secret or not", () =>
    withApp({ production: true }, async ({ app }) => {
      // Behind Render's proxy each call can come from another GitHub runner address.
      const from = (i: number) => ({ "X-Forwarded-For": `203.0.113.${i}` });
      for (let i = 1; i <= 9; i += 1) {
        expect((await request(app).post(PATH).set(from(i)).set("X-Job-Secret", "wrong")).status).toBe(401);
      }
      expect((await request(app).post(PATH).set(from(10)).set("X-Job-Secret", JOB_SECRET)).status).toBe(200);
      const res = await request(app).post(PATH).set(from(11)).set("X-Job-Secret", JOB_SECRET);
      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        error: { code: "rate_limited", message: "Too many job runs. Try again in 15 minutes." },
      });
    }));

  it("never sends the secret back, in any answer", () =>
    withApp({}, async ({ app }) => {
      const answers = [
        await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET),
        await request(app).post(PATH).set("X-Job-Secret", `${JOB_SECRET}x`),
        await request(app).post(PATH),
      ];
      for (const res of answers) {
        expect(JSON.stringify(res.headers) + res.text).not.toContain(JOB_SECRET);
      }
    }));
});

// The fee-rows job inside run-jobs (day 9). Its rules are in tests/feeRows.test.ts; here:
// it runs only with a start date, from India's today, and the answer says what it did.
// Students who joined in 1999 have due dates near the clock; nobody else does.
describe("POST /api/internal/run-jobs: fee rows", () => {
  async function joinedOn(c: PoolClient, date: string): Promise<number> {
    const id = await insertStudent(c);
    await c.query(`UPDATE users SET joining_date = $2, monthly_fee = 5000 WHERE id = $1`, [id, date]);
    return id;
  }
  const feeDates = async (c: PoolClient, id: number) =>
    (await c.query<{ d: string }>(`SELECT due_date AS d FROM fees WHERE student_id = $1 ORDER BY due_date`, [id])).rows.map(
      (r) => r.d,
    );

  it("creates the fee rows due within 7 days when FEES_START_DATE is set, and says how many", () =>
    withApp({ feesStartDate: "1999-01-01" }, async ({ c, app }) => {
      const s = await joinedOn(c, "1999-01-15"); // due 15 February, within 7 days of 10 February
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expirePhotos: { deleted: 0, failed: 0 }, feeRows: { created: 1 } });
      expect(await feeDates(c, s)).toEqual(["1999-02-15"]);
    }));

  it("creates nothing and answers feeRows null without FEES_START_DATE", () =>
    withApp({}, async ({ c, app }) => {
      const s = await joinedOn(c, "1999-01-15");
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);
      expect(res.body.feeRows).toBeNull();
      expect(await feeDates(c, s)).toEqual([]);
    }));

  it("counts 7 days from India's today, not UTC's", () =>
    // 20:00 UTC on 10 February is 01:30 on 11 February in India: the window ends on the 18th.
    withApp({ feesStartDate: "1999-01-01", clock: () => new Date("1999-02-10T20:00:00Z") }, async ({ c, app }) => {
      const s = await joinedOn(c, "1999-01-18");
      await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);
      expect(await feeDates(c, s)).toEqual(["1999-02-18"]);
    }));

  it("creates no row before the start date", () =>
    withApp({ feesStartDate: "1999-02-16" }, async ({ c, app }) => {
      const s = await joinedOn(c, "1999-01-15");
      const res = await request(app).post(PATH).set("X-Job-Secret", JOB_SECRET);
      expect(res.body.feeRows).toEqual({ created: 0 });
      expect(await feeDates(c, s)).toEqual([]);
    }));
});


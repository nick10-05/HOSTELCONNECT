import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { HttpError } from "../src/lib/http";
import { createComplaint, type ComplaintLimits, type PhotoUploads } from "../src/services/complaints";
import { inRollback, insertStudent, testPool } from "./helpers/db";
import { fakeStorage, type FakeStorage } from "./helpers/fakeStorage";
import { rollbackDb } from "./helpers/rollbackDb";

// A complaint with its optional photo (day 8, Claude): createComplaint uploads the photo
// inside the same transaction, after the student lock and the three limits, and only
// while the usage guard allows uploads. Fake storage; the egress month is in 2001, which
// no other test touches. Most tests run on rollbackDb; the race test commits.
const db = testPool();
afterAll(() => db.end());

const LIMITS: ComplaintLimits = { maxActive: 3, maxNewPer24h: 2 };
const NOW = new Date("2001-05-10T06:30:00Z");
const MB = 1024 * 1024;
const TEXT = "The tap in the bathroom leaks all night.";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const uploadsWith = (storage: FakeStorage | null, egressLimitMb = 100_000): PhotoUploads => ({
  storage,
  usageLimits: { storageLimitMb: 100_000, egressLimitMb },
  now: NOW,
});

const withPhoto = (category = "plumbing") => ({
  category: category as "plumbing",
  description: TEXT,
  photo: { bytes: JPEG, type: "image/jpeg" as const },
});

async function refusal(call: Promise<unknown>) {
  const err = await call.then(
    () => {
      throw new Error("expected a refusal, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const { status, code, message } = err as HttpError;
  return { status, code, message };
}

const complaintsOf = async (c: Pick<PoolClient, "query">, student: number) =>
  (
    await c.query(
      `SELECT photo_path AS path, photo_size_bytes AS size,
              photo_expires_at - created_at = interval '48 hours' AS "expires48h",
              photo_deleted_at AS "deletedAt", photo_delete_attempts AS attempts
       FROM complaints WHERE student_id = $1 ORDER BY id`,
      [student],
    )
  ).rows;

function inApp(fn: (c: PoolClient, appDb: Db) => Promise<void>) {
  return inRollback(db, (c) => fn(c, rollbackDb(c)));
}

describe("createComplaint with a photo", () => {
  it("stores the photo under a random name and keeps it 48 hours", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      const { id } = await createComplaint(appDb, student, withPhoto(), LIMITS, uploadsWith(storage));

      const [row] = await complaintsOf(c, student);
      expect(row).toMatchObject({ size: JPEG.length, expires48h: true, deletedAt: null, attempts: 0 });
      expect(row.path).toMatch(/^complaints\/[0-9a-f-]{36}\.jpg$/);
      expect(storage.objects.get(row.path)).toEqual({ bytes: JPEG, type: "image/jpeg" });
      // Still one timeline entry, as for a text complaint.
      const { rows } = await c.query("SELECT kind FROM complaint_events WHERE complaint_id = $1", [id]);
      expect(rows).toEqual([{ kind: "created" }]);
    }));

  it("creates a text complaint as before when there is no photo, without asking storage", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      await createComplaint(appDb, student, { category: "plumbing", description: TEXT }, LIMITS, uploadsWith(storage));
      await createComplaint(appDb, student, { category: "food", description: TEXT, photo: null }, LIMITS);
      expect(await complaintsOf(c, student)).toEqual([
        { path: null, size: null, expires48h: null, deletedAt: null, attempts: 0 },
        { path: null, size: null, expires48h: null, deletedAt: null, attempts: 0 },
      ]);
      expect(storage.calls).toEqual([]);
    }));

  it("refuses a photo while uploads are off (no storage), creating nothing", () =>
    inApp(async (c, appDb) => {
      const student = await insertStudent(c);
      for (const uploads of [undefined, uploadsWith(null)]) {
        expect(await refusal(createComplaint(appDb, student, withPhoto(), LIMITS, uploads))).toEqual({
          status: 409,
          code: "photo_uploads_off",
          message: "Photo uploads are switched off for now. Please send the complaint without a photo.",
        });
      }
      expect(await complaintsOf(c, student)).toEqual([]);
    }));

  it("refuses a photo once the usage guard has switched uploads off, creating nothing", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      // 85% of a 1 MB egress limit, this India month.
      await c.query("INSERT INTO usage_counters (key, value) VALUES ('egress:2001-05', $1)", [Math.ceil(0.85 * MB)]);
      expect(await refusal(createComplaint(appDb, student, withPhoto(), LIMITS, uploadsWith(storage, 1)))).toMatchObject({
        status: 409,
        code: "photo_uploads_off",
      });
      expect(storage.calls).toEqual([]);
      expect(await complaintsOf(c, student)).toEqual([]);
      // Just below 85%, the same photo goes through.
      await c.query("UPDATE usage_counters SET value = $1 WHERE key = 'egress:2001-05'", [Math.ceil(0.85 * MB) - 1]);
      await createComplaint(appDb, student, withPhoto(), LIMITS, uploadsWith(storage, 1));
      expect(await complaintsOf(c, student)).toHaveLength(1);
    }));

  it("tells a student over a limit about the limit, and uploads nothing", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      await createComplaint(appDb, student, withPhoto("plumbing"), LIMITS, uploadsWith(storage));
      const uploads = storage.calls.length;
      expect(await refusal(createComplaint(appDb, student, withPhoto("plumbing"), LIMITS, uploadsWith(storage)))).toMatchObject({
        status: 429,
        code: "category_active",
      });
      expect(storage.calls).toHaveLength(uploads);
    }));

  it("creates nothing when storage refuses the photo, and the student can send it as text", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      for (const status of [500, null]) {
        storage.failNext("upload", status);
        expect(await refusal(createComplaint(appDb, student, withPhoto(), LIMITS, uploadsWith(storage)))).toEqual({
          status: 503,
          code: "photo_upload_failed",
          message: "The photo could not be saved. Try again, or send the complaint without it.",
        });
      }
      expect(await complaintsOf(c, student)).toEqual([]);
      expect(storage.objects.size).toBe(0);
      await createComplaint(appDb, student, { category: "plumbing", description: TEXT }, LIMITS, uploadsWith(storage));
      expect(await complaintsOf(c, student)).toHaveLength(1);
    }));

  it("removes the uploaded photo again when the complaint cannot be saved after all", () =>
    inApp(async (c, appDb) => {
      const storage = fakeStorage();
      const student = await insertStudent(c);
      // Postgres text cannot hold a NUL character: the insert fails after the upload.
      // (The route refuses such text first; this stands for any failure after uploading.)
      const broken = { ...withPhoto(), description: "Broken text \u0000 here, long enough." };
      await expect(createComplaint(appDb, student, broken, LIMITS, uploadsWith(storage))).rejects.toThrow();
      expect(storage.calls.map((call) => call.operation)).toEqual(["upload", "remove"]);
      expect(storage.objects.size).toBe(0);
      expect(await complaintsOf(c, student)).toEqual([]);
    }));

  it("leaves no photo behind when one student sends two at once and only one may pass (5 rounds)", async () => {
    // Committed, on separate connections: the second waits for the student lock, then
    // meets the one-active-complaint limit before uploading anything.
    for (let round = 1; round <= 5; round += 1) {
      const storage = fakeStorage();
      const student = await insertStudent(db);
      const uploads = { ...uploadsWith(storage), now: new Date() };
      const results = await Promise.allSettled([
        createComplaint(db, student, withPhoto("plumbing"), { maxActive: 1, maxNewPer24h: 5 }, uploads),
        createComplaint(db, student, withPhoto("food"), { maxActive: 1, maxNewPer24h: 5 }, uploads),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const rows = await complaintsOf(db, student);
      expect(rows, `round ${round}`).toHaveLength(1);
      expect([...storage.objects.keys()], `round ${round}`).toEqual([rows[0].path]);
    }
  });
});

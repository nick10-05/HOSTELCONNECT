import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { expirePhotos } from "../src/jobs/expirePhotos";
import { newPhotoPath, type PhotoStorage } from "../src/lib/storage";
import { inRollback, insertStudent, photoJobLockShared, testPool, withPhotoJobLock } from "./helpers/db";
import { fakeStorage, type FakeStorage } from "./helpers/fakeStorage";
import { rollbackDb } from "./helpers/rollbackDb";

// The expire-photos job (Claude, at Nikhil's request; section 12 lists "expiry and retry
// logic" under "You write"). Fake storage and a fixed clock in 1998: no other test file
// has photos due then, and every check looks at this test's own photos only. Most tests
// run the job on rollbackDb (its transactions become savepoints, all rolled back); the
// race test commits, holding the photo-job lock (tests/helpers/db.ts) while it does.
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("1998-04-10T06:30:00Z");
const BEFORE = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

type Options = { expiresAt?: Date; deletedAt?: Date | null; attempts?: number; status?: string };

// A complaint with a photo that is in `storage`, by a new student.
async function complaintWithPhoto(c: Pick<PoolClient, "query">, storage: FakeStorage, opts: Options = {}) {
  const path = newPhotoPath("image/jpeg");
  await storage.upload(path, new Uint8Array([0xff, 0xd8]), "image/jpeg");
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, photo_path, photo_size_bytes,
                             photo_expires_at, photo_deleted_at, photo_delete_attempts,
                             created_at, updated_at)
     VALUES ($1, 'plumbing', 'The tap in the bathroom leaks all night.', $2, $3, 400000, $4, $5, $6,
             '1998-04-08T06:30:00Z', '1998-04-08T06:30:00Z')
     RETURNING id`,
    [
      await insertStudent(c),
      opts.status ?? "open",
      path,
      opts.expiresAt ?? BEFORE(HOUR),
      opts.deletedAt ?? null,
      opts.attempts ?? 0,
    ],
  );
  return { id: rows[0].id, path };
}

const photoState = async (c: Pick<PoolClient, "query">, id: number) =>
  (
    await c.query(
      `SELECT photo_deleted_at AS "deletedAt", photo_delete_attempts AS attempts
       FROM complaints WHERE id = $1`,
      [id],
    )
  ).rows[0];

// The remove calls the job made for these paths (other files' photos are never due in
// 1998, but only our own are looked at).
const removed = (storage: FakeStorage, paths: string[]) =>
  storage.calls.filter((call) => call.operation === "remove" && paths.includes(call.path)).map((call) => call.path);

function inJob(fn: (c: PoolClient, jobDb: Db) => Promise<void>) {
  return inRollback(db, async (c) => {
    await photoJobLockShared(c);
    await fn(c, rollbackDb(c));
  });
}

describe("expirePhotos", () => {
  it("deletes every due photo, and records the deletion only once storage confirms it", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const a = await complaintWithPhoto(c, storage, { expiresAt: BEFORE(2 * HOUR) });
      const b = await complaintWithPhoto(c, storage, { expiresAt: BEFORE(0) }); // due exactly now

      const result = await expirePhotos(jobDb, storage, { now: NOW });
      expect(result).toMatchObject({ deleted: 2, failed: 0 });
      expect(removed(storage, [a.path, b.path])).toEqual([a.path, b.path]); // oldest expiry first
      expect(storage.objects.has(a.path) || storage.objects.has(b.path)).toBe(false);
      for (const { id } of [a, b]) expect(await photoState(c, id)).toEqual({ deletedAt: NOW, attempts: 0 });
    }));

  it("leaves photos that are not due yet, already deleted, or absent", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const later = await complaintWithPhoto(c, storage, { expiresAt: new Date(NOW.getTime() + 1) });
      const gone = await complaintWithPhoto(c, storage, { deletedAt: BEFORE(HOUR / 2) });
      await c.query(
        `INSERT INTO complaints (student_id, category, description)
         VALUES ($1, 'electrical', 'The fan in my room does not turn on.')`,
        [await insertStudent(c)],
      );

      await expirePhotos(jobDb, storage, { now: NOW });
      expect(removed(storage, [later.path, gone.path])).toEqual([]);
      expect(await photoState(c, later.id)).toEqual({ deletedAt: null, attempts: 0 });
      expect(await photoState(c, gone.id)).toEqual({ deletedAt: BEFORE(HOUR / 2), attempts: 0 });
    }));

  it("counts a failed deletion, tries it once per run, and succeeds on a later run", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const photo = await complaintWithPhoto(c, storage);

      storage.failNext("remove", 500, 500, 500); // more failures queued than one run uses
      const first = await expirePhotos(jobDb, storage, { now: NOW });
      expect(first).toMatchObject({ deleted: 0, failed: 1 });
      expect(removed(storage, [photo.path])).toHaveLength(1);
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: null, attempts: 1 });

      // The next two hourly runs use up the two failures still queued; then storage works.
      await expirePhotos(jobDb, storage, { now: new Date(NOW.getTime() + HOUR) });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: null, attempts: 2 });
      await expirePhotos(jobDb, storage, { now: new Date(NOW.getTime() + 2 * HOUR) });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: null, attempts: 3 });

      const last = await expirePhotos(jobDb, storage, { now: new Date(NOW.getTime() + 3 * HOUR) });
      expect(last).toMatchObject({ deleted: 1, failed: 0 });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: new Date(NOW.getTime() + 3 * HOUR), attempts: 3 });
      expect(storage.objects.has(photo.path)).toBe(false);
    }));

  it("keeps trying after 5 failures (the dashboard warns; the job does not give up)", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const photo = await complaintWithPhoto(c, storage, { attempts: 7 });
      storage.failNext("remove", null);
      await expirePhotos(jobDb, storage, { now: NOW });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: null, attempts: 8 });
      await expirePhotos(jobDb, storage, { now: NOW });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: NOW, attempts: 8 });
    }));

  it("records a photo storage no longer had as deleted", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const photo = await complaintWithPhoto(c, storage);
      storage.objects.delete(photo.path); // gone already, e.g. a run that stopped after deleting
      const result = await expirePhotos(jobDb, storage, { now: NOW });
      expect(result).toMatchObject({ deleted: 1, failed: 0 });
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: NOW, attempts: 0 });
    }));

  it("takes at most `limit` photos per run, oldest expiry first, and the rest next time", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const newest = await complaintWithPhoto(c, storage, { expiresAt: BEFORE(HOUR) });
      const oldest = await complaintWithPhoto(c, storage, { expiresAt: BEFORE(3 * HOUR) });
      const middle = await complaintWithPhoto(c, storage, { expiresAt: BEFORE(2 * HOUR) });
      const paths = [newest.path, oldest.path, middle.path];

      expect(await expirePhotos(jobDb, storage, { now: NOW, limit: 2 })).toMatchObject({ deleted: 2 });
      expect(removed(storage, paths)).toEqual([oldest.path, middle.path]);
      await expirePhotos(jobDb, storage, { now: NOW, limit: 2 });
      expect(removed(storage, paths)).toEqual([oldest.path, middle.path, newest.path]);
    }));

  it("changes nothing else about the complaint: no status, no updated_at, no event, no notification", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const photo = await complaintWithPhoto(c, storage, { status: "in_progress" });
      const snapshot = async () =>
        (
          await c.query(
            `SELECT status, priority, description, updated_at, resolved_at, photo_path, photo_size_bytes,
                    photo_expires_at,
                    (SELECT count(*)::int FROM complaint_events WHERE complaint_id = c.id) AS events,
                    (SELECT count(*)::int FROM notifications WHERE user_id = c.student_id) AS notifications
             FROM complaints c WHERE id = $1`,
            [photo.id],
          )
        ).rows[0];
      const before = await snapshot();
      await expirePhotos(jobDb, storage, { now: NOW });
      expect(await snapshot()).toEqual(before);
    }));

  it("does nothing without storage, or with no time left", () =>
    inJob(async (c, jobDb) => {
      const storage = fakeStorage();
      const photo = await complaintWithPhoto(c, storage);
      expect(await expirePhotos(jobDb, null, { now: NOW })).toEqual({ deleted: 0, failed: 0 });
      expect(await expirePhotos(jobDb, storage, { now: NOW, timeLimitMs: 0 })).toEqual({ deleted: 0, failed: 0 });
      expect(storage.calls.filter((call) => call.operation !== "upload")).toEqual([]);
      expect(await photoState(c, photo.id)).toEqual({ deletedAt: null, attempts: 0 });
    }));

  it("never handles a photo twice when two runs overlap (5 rounds)", () =>
    // Committed, two runs at once on the real pool. Storage is slow, so both runs are
    // busy at the same time. These photos are due for any job run with a later clock, so
    // the photo-job lock keeps such tests (jobsRoutes.test.ts) waiting meanwhile.
    withPhotoJobLock(db, async () => {
      const ids: number[] = [];
      try {
        for (let round = 1; round <= 5; round += 1) {
          const fake = fakeStorage();
          const slow: PhotoStorage = {
            upload: fake.upload,
            signedUrl: fake.signedUrl,
            remove: async (path) => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return fake.remove(path);
            },
          };
          const now = new Date(`1998-0${4 + round}-10T06:30:00Z`); // a month of its own per round
          const photos = [];
          for (let i = 0; i < 6; i += 1) {
            photos.push(await complaintWithPhoto(db, fake, { expiresAt: new Date(now.getTime() - (i + 1) * 60_000) }));
            ids.push(photos[i].id);
          }
          const paths = photos.map((p) => p.path);

          const results = await Promise.all([expirePhotos(db, slow, { now }), expirePhotos(db, slow, { now })]);
          const calls = removed(fake, paths);
          expect([...calls].sort(), `round ${round}`).toEqual([...paths].sort()); // each exactly once
          expect(results.reduce((sum, r) => sum + r.deleted, 0), `round ${round}`).toBe(6);
          expect(results.every((r) => r.failed === 0)).toBe(true);
          for (const { id } of photos) expect(await photoState(db, id)).toEqual({ deletedAt: now, attempts: 0 });
        }
      } finally {
        // Should a round fail, its photos would stay due for every later job run: mark
        // them deleted before the lock is released.
        await db.query("UPDATE complaints SET photo_deleted_at = $2 WHERE id = ANY($1) AND photo_deleted_at IS NULL", [
          ids,
          NOW,
        ]);
      }
    }));
});

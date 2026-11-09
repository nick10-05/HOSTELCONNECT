import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { AMBER_PERCENT, egressKey, getUsage, UPLOADS_OFF_PERCENT, type UsageLimits } from "../src/services/usage";
import { inRollback, insertStudent, testPool } from "./helpers/db";
import { asHostel } from "./helpers/hostels";

// The usage guard (Nikhil). Other test files add complaints at the same time, so storage
// and failed deletions are totals over every complaint: each test runs in one rolled-back
// snapshot (REPEATABLE READ), reads what was already there with plain SQL, and adds its
// own photos on top. Egress uses months in 1995, which no other test touches. The clock is
// fixed: `now` is always passed in.
const db = testPool();
afterAll(() => db.end());

const MB = 1024 * 1024;
// 10,000 MB: 70% and 85% are whole numbers of bytes (7,340,032,000 and 8,912,896,000).
const LIMITS: UsageLimits = { storageLimitMb: 10_000, egressLimitMb: 10_000 };
const LIMIT_BYTES = 10_000 * MB;
const AT = (percent: number) => (LIMIT_BYTES * percent) / 100;

// 1995-03-15 12:00 in India.
const NOW = new Date("1995-03-15T06:30:00Z");

function inSnapshot(fn: (c: PoolClient) => Promise<void>) {
  return inRollback(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await fn(c);
  });
}

// What was already in storage (every hostel's, through the database's own total, which
// row-level security would otherwise hide) and failing (this hostel's), read without the
// code under test.
async function before(c: PoolClient) {
  const { rows } = await c.query<{ stored: number; failing: number }>(
    `SELECT photo_storage_bytes() AS stored,
            count(*) FILTER (WHERE photo_delete_attempts >= 5)::int AS failing
     FROM complaints WHERE photo_path IS NOT NULL AND photo_deleted_at IS NULL`,
  );
  return rows[0];
}

type Photo = { attempts?: number; deletedAt?: Date | null; expiresAt?: Date };

// A complaint with a photo of `bytes` bytes, by a new student (so no complaint limit
// gets in the way). Larger amounts are split over several photos: the column is an
// integer, at most about 2.1 GB.
async function photo(c: PoolClient, bytes: number, opts: Photo = {}) {
  for (let left = bytes; left > 0; ) {
    const size = Math.min(left, 2_000_000_000);
    left -= size;
    await c.query(
      `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes,
                               photo_expires_at, photo_deleted_at, photo_delete_attempts)
       VALUES ($1, 'plumbing', 'The tap in the bathroom leaks all night.', $2, $3, $4, $5, $6)`,
      [
        await insertStudent(c),
        `complaints/${crypto.randomUUID()}.jpg`,
        size,
        opts.expiresAt ?? new Date("1995-03-16T06:30:00Z"),
        opts.deletedAt ?? null,
        opts.attempts ?? 0,
      ],
    );
  }
}

// Brings storage in use to exactly `bytes`, counting what other tests left. The photos
// go to a hostel of their own, so hostel #1's own share (phase 5b) stays as it was and
// only the whole bucket's limit is tested.
async function storageAt(c: PoolClient, bytes: number) {
  const { stored } = await before(c);
  if (bytes < stored) throw new Error("the test database already holds more photos than this test needs");
  if (bytes > stored) {
    const filler = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Filler') RETURNING id")).rows[0].id;
    await asHostel(c, filler);
    await photo(c, bytes - stored);
    await asHostel(c, 1);
  }
}

async function egressAt(c: PoolClient, key: string, bytes: number) {
  await c.query("INSERT INTO usage_counters (key, value) VALUES ($1, $2)", [key, bytes]);
}

describe("egressKey", () => {
  it("names the month in India's calendar", () => {
    expect(egressKey(NOW)).toBe("egress:1995-03");
    expect(egressKey(new Date("1995-12-31T12:00:00Z"))).toBe("egress:1995-12");
    expect(egressKey(new Date("1995-01-01T00:00:00+05:30"))).toBe("egress:1995-01");
  });

  it("starts a new month at midnight India time, 18:30 UTC the day before", () => {
    expect(egressKey(new Date("1995-03-31T18:29:59.999Z"))).toBe("egress:1995-03");
    expect(egressKey(new Date("1995-03-31T18:30:00.000Z"))).toBe("egress:1995-04");
    expect(egressKey(new Date("1995-12-31T18:29:59.999Z"))).toBe("egress:1995-12");
    expect(egressKey(new Date("1995-12-31T18:30:00.000Z"))).toBe("egress:1996-01");
    // A leap day, and a month whose UTC date is still the month before.
    expect(egressKey(new Date("1996-02-29T20:00:00Z"))).toBe("egress:1996-03");
    expect(egressKey(new Date("1996-02-29T18:00:00Z"))).toBe("egress:1996-02");
  });
});

describe("getUsage", () => {
  it("counts photos that exist and are not deleted, expired or not, and nothing else", () =>
    inSnapshot(async (c) => {
      const { stored } = await before(c);
      await photo(c, 300_000);
      await photo(c, 200_000, { expiresAt: new Date("1995-03-14T06:30:00Z") }); // expired, deletion pending
      await photo(c, 500_000, { deletedAt: new Date("1995-03-14T07:00:00Z") }); // deleted: not counted
      // A complaint without a photo.
      await c.query(
        `INSERT INTO complaints (student_id, category, description)
         VALUES ($1, 'electrical', 'The fan in my room does not turn on.')`,
        [await insertStudent(c)],
      );

      const usage = await getUsage(c, LIMITS, NOW);
      expect(usage.storage).toEqual({
        usedBytes: stored + 500_000,
        limitBytes: LIMIT_BYTES,
        percent: Math.floor(((stored + 500_000) * 100) / LIMIT_BYTES),
      });
    }));

  // Multi-tenant phase 2d: the storage limit is the one shared bucket's, so every hostel's
  // photos count, though row-level security hides the other hostels' rows; a failing
  // deletion is shown only to the owner of the hostel it belongs to.
  it("counts every hostel's photos for storage, and only this hostel's failing deletions", () =>
    inSnapshot(async (c) => {
      const { stored, failing } = await before(c);
      const other = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Usage Hostel') RETURNING id"))
        .rows[0].id;
      await asHostel(c, other);
      await photo(c, 400_000, { attempts: 5 });
      await asHostel(c, 1);

      const usage = await getUsage(c, LIMITS, NOW);
      expect(usage.storage.usedBytes).toBe(stored + 400_000);
      expect(usage.failingDeletions).toBe(failing);
    }));

  it("reads this India month's egress counter, and 0 for a month with none", () =>
    inSnapshot(async (c) => {
      await egressAt(c, "egress:1995-02", 999_999); // last month: not counted
      expect((await getUsage(c, LIMITS, NOW)).egress).toEqual({
        month: "1995-03",
        usedBytes: 0,
        limitBytes: LIMIT_BYTES,
        percent: 0,
      });

      await egressAt(c, "egress:1995-03", 1_500_000);
      expect((await getUsage(c, LIMITS, NOW)).egress).toMatchObject({ month: "1995-03", usedBytes: 1_500_000 });
      // 18:30 UTC on 31 March is already April in India.
      expect((await getUsage(c, LIMITS, new Date("1995-03-31T18:30:00Z"))).egress).toMatchObject({
        month: "1995-04",
        usedBytes: 0,
      });
    }));

  it("uses MB of 1024 * 1024 bytes and rounds the percentage down", () =>
    inSnapshot(async (c) => {
      const limits = { storageLimitMb: 450, egressLimitMb: 3000 };
      await egressAt(c, "egress:1995-03", 3000 * MB * 0.7 - 1); // just under 70%
      const usage = await getUsage(c, limits, NOW);
      expect(usage.storage.limitBytes).toBe(450 * MB);
      expect(usage.egress).toMatchObject({ limitBytes: 3000 * MB, percent: 69 });
    }));

  it("lets percentages pass 100", () =>
    inSnapshot(async (c) => {
      await egressAt(c, "egress:1995-03", LIMIT_BYTES * 2);
      expect((await getUsage(c, LIMITS, NOW)).egress.percent).toBe(200);
    }));

  it("is ok below 70%, amber from 70% and uploads off from 85% of the storage limit", () =>
    inSnapshot(async (c) => {
      expect(AMBER_PERCENT).toBe(70);
      expect(UPLOADS_OFF_PERCENT).toBe(85);
      const levels: Array<[number, string, boolean, number]> = [
        [AT(70) - 1, "ok", true, 69],
        [AT(70), "amber", true, 70],
        [AT(85) - 1, "amber", true, 84],
        [AT(85), "uploads_off", false, 85],
        [AT(100), "uploads_off", false, 100],
      ];
      for (const [bytes, level, uploadsAllowed, percent] of levels) {
        await storageAt(c, bytes);
        const usage = await getUsage(c, LIMITS, NOW);
        expect(usage, `${bytes} bytes stored`).toMatchObject({ level, uploadsAllowed, storage: { percent } });
      }
    }));

  it("is ok below 70%, amber from 70% and uploads off from 85% of the egress limit", () =>
    inSnapshot(async (c) => {
      await egressAt(c, "egress:1995-03", 0);
      const levels: Array<[number, string, boolean]> = [
        [AT(70) - 1, "ok", true],
        [AT(70), "amber", true],
        [AT(85) - 1, "amber", true],
        [AT(85), "uploads_off", false],
      ];
      for (const [bytes, level, uploadsAllowed] of levels) {
        await c.query("UPDATE usage_counters SET value = $2 WHERE key = $1", ["egress:1995-03", bytes]);
        const usage = await getUsage(c, LIMITS, NOW);
        expect(usage, `${bytes} bytes of egress`).toMatchObject({ level, uploadsAllowed });
      }
    }));

  it("takes the worse of the two limits", () =>
    inSnapshot(async (c) => {
      await storageAt(c, AT(70)); // storage amber
      expect(await getUsage(c, LIMITS, NOW)).toMatchObject({ level: "amber", uploadsAllowed: true });

      await egressAt(c, "egress:1995-03", AT(85)); // egress off
      expect(await getUsage(c, LIMITS, NOW)).toMatchObject({ level: "uploads_off", uploadsAllowed: false });

      // Egress fine, storage off.
      expect(await getUsage(c, { storageLimitMb: 10_000, egressLimitMb: 100_000 }, NOW)).toMatchObject({
        level: "amber",
      });
      await storageAt(c, AT(85));
      expect(await getUsage(c, { storageLimitMb: 10_000, egressLimitMb: 100_000 }, NOW)).toMatchObject({
        level: "uploads_off",
        uploadsAllowed: false,
      });
    }));

  // Phase 5b: each hostel's equal share of the storage limit.
  it("gives each hostel an equal share of storage, counting its own photos only", () =>
    inSnapshot(async (c) => {
      const mine = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Share Hostel') RETURNING id")).rows[0].id;
      const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM hostels WHERE status = 'active'");
      const shareBytes = Math.floor(LIMIT_BYTES / rows[0].n);
      await asHostel(c, mine);
      await photo(c, 300_000);
      await photo(c, 100_000, { deletedAt: new Date("1995-03-14T07:00:00Z") }); // deleted: not counted

      const usage = await getUsage(c, LIMITS, NOW);
      expect(usage.hostelStorage).toEqual({
        usedBytes: 300_000,
        limitBytes: shareBytes,
        percent: Math.floor((300_000 * 100) / shareBytes),
      });
    }));

  it("turns this hostel's uploads off at 85% of its share, while the bucket has room", () =>
    inSnapshot(async (c) => {
      const mine = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Busy Hostel') RETURNING id")).rows[0].id;
      const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM hostels WHERE status = 'active'");
      const shareBytes = Math.floor(LIMIT_BYTES / rows[0].n);
      await asHostel(c, mine);
      await photo(c, Math.ceil(shareBytes * 0.7));
      expect(await getUsage(c, LIMITS, NOW)).toMatchObject({ level: "amber", uploadsAllowed: true });
      await photo(c, Math.ceil(shareBytes * 0.15));
      const usage = await getUsage(c, LIMITS, NOW);
      expect(usage).toMatchObject({ level: "uploads_off", uploadsAllowed: false });
      expect(usage.storage.percent).toBeLessThan(AMBER_PERCENT);

      // The other hostels' uploads are not affected.
      await asHostel(c, 1);
      expect((await getUsage(c, LIMITS, NOW)).hostelStorage.percent).toBeLessThan(AMBER_PERCENT);
    }));

  it("counts the photos not yet deleted that have failed 5 times or more", () =>
    inSnapshot(async (c) => {
      const { failing } = await before(c);
      await photo(c, 1000, { attempts: 4 });
      await photo(c, 1000, { attempts: 5 });
      await photo(c, 1000, { attempts: 7 });
      // Deleted in the end, after many failures: no longer a warning.
      await photo(c, 1000, { attempts: 9, deletedAt: new Date("1995-03-15T05:00:00Z") });
      expect((await getUsage(c, LIMITS, NOW)).failingDeletions).toBe(failing + 2);
    }));

  it("writes nothing", () =>
    inSnapshot(async (c) => {
      await egressAt(c, "egress:1995-03", 10);
      const { rows: counters } = await c.query("SELECT key, value, updated_at FROM usage_counters ORDER BY key");
      await getUsage(c, LIMITS, NOW);
      await getUsage(c, LIMITS, new Date("1995-05-01T00:00:00Z"));
      const { rows: after } = await c.query("SELECT key, value, updated_at FROM usage_counters ORDER BY key");
      expect(after).toEqual(counters);
    }));
});

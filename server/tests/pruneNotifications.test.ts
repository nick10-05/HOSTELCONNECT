import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { NOTIFICATION_DAYS_KEPT, pruneNotifications } from "../src/jobs/pruneNotifications";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// The prune job (day 10, Claude). It looks at every notification, so each test runs in a
// transaction that is rolled back, with notifications dated in 1995 and a clock in 1995:
// every other file's notifications are years newer, so nothing else is old enough and every
// count here is exact.
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("1995-06-30T12:00:00Z");
const DAY = 86_400_000;

// A notification for `user`, created `daysAgo` days (and `ms` milliseconds) before NOW.
async function notificationFrom(c: PoolClient, user: number, daysAgo: number, opts: { ms?: number; read?: boolean } = {}) {
  const createdAt = new Date(NOW.getTime() - daysAgo * DAY - (opts.ms ?? 0));
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO notifications (user_id, type, title, created_at, read_at)
     VALUES ($1, 'announcement', 'Old notice', $2, $3) RETURNING id`,
    [user, createdAt, opts.read ? createdAt : null],
  );
  return rows[0].id;
}

const left = async (c: PoolClient, ids: number[]) =>
  (await c.query<{ id: number }>(`SELECT id FROM notifications WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids])).rows.map(
    (r) => r.id,
  );

describe("pruneNotifications", () => {
  it("deletes notifications more than 60 days old, read or not, and keeps newer ones", () =>
    inRollback(db, async (c) => {
      expect(NOTIFICATION_DAYS_KEPT).toBe(60);
      const s = await insertStudent(c);
      const old = await notificationFrom(c, s, 61);
      const oldRead = await notificationFrom(c, s, 90, { read: true });
      const recent = await notificationFrom(c, s, 59);
      const today = await notificationFrom(c, s, 0);

      expect(await pruneNotifications(c, { now: NOW })).toEqual({ deleted: 2 });
      expect(await left(c, [old, oldRead, recent, today])).toEqual([recent, today]);
    }));

  it("keeps one exactly 60 days old, and deletes it a moment later", () =>
    inRollback(db, async (c) => {
      const s = await insertStudent(c);
      const edge = await notificationFrom(c, s, 60);
      const past = await notificationFrom(c, s, 60, { ms: 1000 });

      expect(await pruneNotifications(c, { now: NOW })).toEqual({ deleted: 1 });
      expect(await left(c, [edge, past])).toEqual([edge]);
    }));

  it("deletes everyone's: students' and the owner's", () =>
    inRollback(db, async (c) => {
      const s = await insertStudent(c);
      const owner = await insertOwner(c);
      const ids = [await notificationFrom(c, s, 70), await notificationFrom(c, owner, 70)];
      expect(await pruneNotifications(c, { now: NOW })).toEqual({ deleted: 2 });
      expect(await left(c, ids)).toEqual([]);
    }));

  it("deletes nothing when nothing is old enough, and nothing twice", () =>
    inRollback(db, async (c) => {
      const s = await insertStudent(c);
      await notificationFrom(c, s, 61);
      expect(await pruneNotifications(c, { now: NOW })).toEqual({ deleted: 1 });
      expect(await pruneNotifications(c, { now: NOW })).toEqual({ deleted: 0 });
    }));
});

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  announcementKey,
  deleteAnnouncement,
  deleteAnnouncementInTransaction,
  listAnnouncements,
  NOTICES_LINK,
  postAnnouncementInTransaction,
  updateAnnouncement,
  type NewAnnouncement,
} from "../src/services/announcements";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// The announcement service. Posting notifies EVERY active student, including other test
// files' students, so every test that posts runs inside a transaction that is rolled
// back (lesson from day 6), with one snapshot of the database (REPEATABLE READ): counts
// of "every active student" are taken in that same snapshot.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const NOTICE: NewAnnouncement = {
  title: "Water off on Sunday",
  body: "The tank is being cleaned from 9 am to 1 pm. Please store water the night before.",
  isUrgent: false,
  isPinned: false,
};
const FIELDS = ["body", "createdAt", "id", "isPinned", "isUrgent", "title", "updatedAt"];

function inSnapshot(fn: (c: PoolClient) => Promise<void>) {
  return inRollback(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await fn(c);
  });
}

const count = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(sql, params)).rows[0].n;

const activeStudents = (c: PoolClient) =>
  count(c, "SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_active");

const notificationsWithKey = (c: PoolClient, key: string) =>
  count(c, "SELECT count(*)::int AS n FROM notifications WHERE dedup_key = $1", [key]);

// The notifications one user has, as the bell would show them.
const bellOf = async (c: PoolClient, userId: number) =>
  (
    await c.query(
      `SELECT type, title, body, link, dedup_key AS "dedupKey", read_at AS "readAt"
       FROM notifications WHERE user_id = $1 ORDER BY id`,
      [userId],
    )
  ).rows;

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

const NOT_FOUND = { status: 404, code: "announcement_not_found", message: "That announcement does not exist." };

// An announcement written straight to the table at a given time, without notifying anyone.
async function addAnnouncement(c: PoolClient, opts: { pinned?: boolean; at: string }) {
  const owner = await insertOwner(c);
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO announcements (author_id, title, body, is_pinned, created_at, updated_at)
     VALUES ($1, 'Notice', 'Text of the notice.', $2, $3, $3) RETURNING id`,
    [owner, opts.pinned ?? false, opts.at],
  );
  return rows[0].id;
}

describe("postAnnouncementInTransaction (you write it)", () => {
  it("stores the announcement and returns it", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);

      const posted = await postAnnouncementInTransaction(c, owner, { ...NOTICE, isPinned: true });

      expect(Object.keys(posted).sort()).toEqual(FIELDS);
      expect(posted).toMatchObject({ title: NOTICE.title, body: NOTICE.body, isUrgent: false, isPinned: true });
      expect(posted.createdAt).toBeInstanceOf(Date);
      const { rows } = await c.query("SELECT author_id, title, is_pinned FROM announcements WHERE id = $1", [posted.id]);
      expect(rows).toEqual([{ author_id: owner, title: NOTICE.title, is_pinned: true }]);
    }));

  it("notifies every active student exactly once, with fixed text and no copy of the announcement", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const movedOut = await insertStudent(c, { isActive: false });

      const posted = await postAnnouncementInTransaction(c, owner, NOTICE);

      const key = announcementKey(posted.id);
      expect(key).toBe(`announcement:${posted.id}`);
      expect(await notificationsWithKey(c, key)).toBe(await activeStudents(c));
      expect(await bellOf(c, student)).toEqual([
        {
          type: "announcement",
          title: "New notice from the hostel.",
          body: null,
          link: NOTICES_LINK,
          dedupKey: key,
          readAt: null,
        },
      ]);
      expect(NOTICES_LINK).toBe("/notices");
      // Nothing for a moved-out student or for the owner.
      expect(await bellOf(c, movedOut)).toEqual([]);
      expect(await bellOf(c, owner)).toEqual([]);
      // No notification anywhere repeats the announcement's text.
      const repeats = await count(
        c,
        "SELECT count(*)::int AS n FROM notifications WHERE dedup_key = $1 AND (title LIKE '%Water%' OR body IS NOT NULL)",
        [key],
      );
      expect(repeats).toBe(0);
    }));

  it("says 'urgent' in the notification of an urgent announcement", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      await postAnnouncementInTransaction(c, await insertOwner(c), { ...NOTICE, isUrgent: true });
      expect((await bellOf(c, student)).map((n) => n.title)).toEqual(["Urgent notice from the hostel."]);
    }));

  it("gives each announcement its own notifications", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const first = await postAnnouncementInTransaction(c, owner, NOTICE);
      const second = await postAnnouncementInTransaction(c, owner, { ...NOTICE, title: "Mess closed on Monday" });

      expect((await bellOf(c, student)).map((n) => n.dedupKey)).toEqual([
        announcementKey(first.id),
        announcementKey(second.id),
      ]);
    }));
});

describe("deleteAnnouncementInTransaction (you write it)", () => {
  it("deletes the announcement and all its notifications, read or not, and nothing else", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const doomed = await postAnnouncementInTransaction(c, owner, NOTICE);
      const kept = await postAnnouncementInTransaction(c, owner, { ...NOTICE, title: "Mess closed on Monday" });
      // Another kind of notification for the same student, and one that has been read.
      await c.query(
        `INSERT INTO notifications (user_id, type, title, link) VALUES ($1, 'complaint_update', 'Your food complaint is now resolved.', '/complaints/1')`,
        [student],
      );
      await c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND dedup_key = $2", [
        student,
        announcementKey(doomed.id),
      ]);
      const keptBefore = await notificationsWithKey(c, announcementKey(kept.id));

      await deleteAnnouncementInTransaction(c, doomed.id);

      expect(await count(c, "SELECT count(*)::int AS n FROM announcements WHERE id = $1", [doomed.id])).toBe(0);
      expect(await notificationsWithKey(c, announcementKey(doomed.id))).toBe(0);
      // The other announcement and its notifications, and other notifications, stay.
      expect(await count(c, "SELECT count(*)::int AS n FROM announcements WHERE id = $1", [kept.id])).toBe(1);
      expect(await notificationsWithKey(c, announcementKey(kept.id))).toBe(keptBefore);
      expect((await bellOf(c, student)).map((n) => n.type)).toEqual(["announcement", "complaint_update"]);
    }));

  it("matches the key exactly: deleting announcement 1 leaves announcement 12's notifications", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const posted = await postAnnouncementInTransaction(c, owner, NOTICE);
      // A notification whose key starts with the same text (as 'announcement:12' does for 1).
      const lookalike = `${announcementKey(posted.id)}0`;
      await c.query(
        `INSERT INTO notifications (user_id, type, title, link, dedup_key) VALUES ($1, 'announcement', 'Old.', '/notices', $2)`,
        [student, lookalike],
      );

      await deleteAnnouncementInTransaction(c, posted.id);

      expect(await notificationsWithKey(c, lookalike)).toBe(1);
    }));

  it("refuses an announcement that does not exist, and deletes nothing", () =>
    inSnapshot(async (c) => {
      const posted = await postAnnouncementInTransaction(c, await insertOwner(c), NOTICE);
      const before = await notificationsWithKey(c, announcementKey(posted.id));

      expect(await refusal(deleteAnnouncementInTransaction(c, MISSING))).toEqual(NOT_FOUND);

      expect(await notificationsWithKey(c, announcementKey(posted.id))).toBe(before);
    }));

  it("refuses through the wrapper too (its own transaction)", async () => {
    expect(await refusal(deleteAnnouncement(db, MISSING))).toEqual(NOT_FOUND);
  });
});

// These tests write the announcement (and its notification) straight to the tables, so
// they do not depend on the posting code.
describe("updateAnnouncement (Claude)", () => {
  it("changes each field on its own and keeps the rest", () =>
    inSnapshot(async (c) => {
      const id = await addAnnouncement(c, { at: "2026-11-01T09:00:00+05:30" });

      expect(await updateAnnouncement(c, id, { title: "Water off on Monday" })).toMatchObject({
        title: "Water off on Monday",
        body: "Text of the notice.",
        isUrgent: false,
        isPinned: false,
      });
      expect(await updateAnnouncement(c, id, { body: "Moved to Monday." })).toMatchObject({
        title: "Water off on Monday",
        body: "Moved to Monday.",
      });
      expect(await updateAnnouncement(c, id, { isUrgent: true })).toMatchObject({ isUrgent: true, isPinned: false });
      expect(await updateAnnouncement(c, id, { isPinned: true })).toMatchObject({ isUrgent: true, isPinned: true });
      // false is a value, not "left out".
      const unpinned = await updateAnnouncement(c, id, { isPinned: false, isUrgent: false });
      expect(unpinned).toMatchObject({ isUrgent: false, isPinned: false, title: "Water off on Monday" });
      expect(Object.keys(unpinned).sort()).toEqual(FIELDS);
      expect(unpinned.createdAt).toEqual(new Date("2026-11-01T09:00:00+05:30"));
    }));

  it("sets updated_at to now", () =>
    inSnapshot(async (c) => {
      const id = await addAnnouncement(c, { at: "2026-11-01T09:00:00+05:30" });
      await updateAnnouncement(c, id, { isPinned: true });
      // now() is the transaction's start time, the same in the test and in the service.
      const fresh = await count(c, "SELECT count(*)::int AS n FROM announcements WHERE id = $1 AND updated_at = now()", [
        id,
      ]);
      expect(fresh).toBe(1);
    }));

  it("never notifies again, and leaves the existing notifications as they were", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const id = await addAnnouncement(c, { at: "2026-11-01T09:00:00+05:30" });
      await c.query(
        `INSERT INTO notifications (user_id, type, title, link, dedup_key)
         VALUES ($1, 'announcement', 'New notice from the hostel.', '/notices', $2)`,
        [student, announcementKey(id)],
      );
      const bellBefore = await bellOf(c, student);
      const allBefore = await count(c, "SELECT count(*)::int AS n FROM notifications");

      await updateAnnouncement(c, id, { title: "Water off on Monday", isUrgent: true });

      expect(await bellOf(c, student)).toEqual(bellBefore);
      expect(await count(c, "SELECT count(*)::int AS n FROM notifications")).toBe(allBefore);
    }));

  it("refuses an announcement that does not exist", () =>
    inSnapshot(async (c) => {
      expect(await refusal(updateAnnouncement(c, MISSING, { isPinned: true }))).toEqual(NOT_FOUND);
    }));
});

describe("listAnnouncements (Claude)", () => {
  it("puts pinned first, then newest, ties by id; pages with the total on every page", () =>
    inSnapshot(async (c) => {
      const before = await listAnnouncements(c, { page: 1, limit: 50 });
      // Far in the future, so these come before anything another file has written.
      const oldPinned = await addAnnouncement(c, { pinned: true, at: "2999-01-01T09:00:00Z" });
      const newPlain = await addAnnouncement(c, { at: "2999-01-05T09:00:00Z" });
      const newPinned = await addAnnouncement(c, { pinned: true, at: "2999-01-03T09:00:00Z" });
      const oldPlain = await addAnnouncement(c, { at: "2999-01-02T09:00:00Z" });
      const sameTime = await addAnnouncement(c, { at: "2999-01-05T09:00:00Z" }); // same moment as newPlain

      const first = await listAnnouncements(c, { page: 1, limit: 50 });
      expect(first.total).toBe(before.total + 5);
      const mine = new Set([oldPinned, newPlain, newPinned, oldPlain, sameTime]);
      const ids = first.items.map((a) => a.id);
      // Pinned ones come before every unpinned one, including other files' unpinned ones.
      expect(ids.slice(0, 2)).toEqual([newPinned, oldPinned]);
      expect(ids.filter((id) => mine.has(id))).toEqual([newPinned, oldPinned, sameTime, newPlain, oldPlain]);
      for (const item of first.items) expect(Object.keys(item).sort()).toEqual(FIELDS);

      const page = (n: number) => listAnnouncements(c, { page: n, limit: 2 });
      expect((await page(1)).items.map((a) => a.id)).toEqual([newPinned, oldPinned]);
      expect((await page(2)).items.map((a) => a.id)).toEqual([sameTime, newPlain]);
      expect((await page(2)).total).toBe(first.total);
      expect((await listAnnouncements(c, { page: 10_000, limit: 50 })).items).toEqual([]);
    }));
});

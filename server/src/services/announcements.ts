import type { PoolClient } from "pg";
import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { notify } from "./notifications";

// Announcements: the owner's notices to every student (design doc, sections 3, 5 and 9).
// Posting notifies every active student once; editing never notifies again; deleting
// removes the announcement and its notifications. Day 7.
// tests/announcements.test.ts describes every function here.
//
// Locking: nothing here locks a student's users row. The fan-out's notification rows take
// only share locks on the students' rows (their foreign key), and none of these functions
// holds anything a complaint or student path waits for, so they cannot deadlock with them.

// One announcement, as both the owner and the students see it. Times are timestamps
// (Date); the screen shows them in India's time.
export type Announcement = {
  id: number;
  title: string;
  body: string;
  isUrgent: boolean;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// What the owner posts. The route (zod) trims title and body and checks them: 1 to 120
// and 1 to 2000 characters, as migration 010 does.
export type NewAnnouncement = {
  title: string;
  body: string;
  isUrgent: boolean;
  isPinned: boolean;
};

// The one link every announcement notification opens: the students' notices page.
export const NOTICES_LINK = "/notices";

// The dedup key that ties an announcement's notifications to it (section 3). There is no
// foreign key from notifications to announcements; this key is the link.
export const announcementKey = (id: number) => `announcement:${id}`;

// Exactly Announcement's fields.
const COLUMNS = `id, title, body, is_urgent AS "isUrgent", is_pinned AS "isPinned",
                 created_at AS "createdAt", updated_at AS "updatedAt"`;

const NOT_FOUND = () => new HttpError(404, "announcement_not_found", "That announcement does not exist.");

// ---- Posting (you write the core) ----

// Inside the caller's transaction (the caller owns BEGIN, COMMIT and ROLLBACK, as with
// reactivateInTransaction): inserts the announcement by `ownerId` with `input`, then
// notifies every active student with notify(c, "active_students", ...):
//   type       'announcement'
//   title      "Urgent notice from the hostel."  when input.isUrgent
//              "New notice from the hostel."     otherwise
//   body       null
//   link       NOTICES_LINK ("/notices")
//   dedupKey   announcementKey(<the new id>)
// The notification never repeats the announcement's own text (decided on day 7): the
// owner might type a phone number into it, and notification text must never contain one.
// It also means an edit can never leave an out-of-date title in anyone's bell.
// Moved-out students and the owner get nothing (notify() takes active students only).
// Returns the new announcement (all of Announcement's fields).
export async function postAnnouncementInTransaction(
  c: Queryable,
  ownerId: number,
  input: NewAnnouncement,
): Promise<Announcement> {
  const { rows } = await c.query<Announcement>(
    `INSERT INTO announcements (author_id, title, body, is_urgent, is_pinned)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [ownerId, input.title, input.body, input.isUrgent, input.isPinned],
  );
  const announcement = rows[0];

  // One notification per active student. Fixed text: never the announcement's own words.
  await notify(c, "active_students", {
    type: "announcement",
    title: input.isUrgent ? "Urgent notice from the hostel." : "New notice from the hostel.",
    body: null,
    link: NOTICES_LINK,
    dedupKey: announcementKey(announcement.id),
  });

  return announcement;
}

// Posts an announcement, all or nothing: the core above in one transaction.
export async function postAnnouncement(db: Db, ownerId: number, input: NewAnnouncement): Promise<Announcement> {
  return inTransaction(db, (c) => postAnnouncementInTransaction(c, ownerId, input));
}

// ---- Deleting (you write the core) ----

// Inside the caller's transaction: deletes the announcement and every notification whose
// dedup_key is announcementKey(id), for every user (section 3: "deleting an announcement
// deletes those notifications"), read or not. Notifications of other announcements, and
// any other notifications, are untouched: match the key exactly, never with LIKE.
//   404 announcement_not_found  "That announcement does not exist."   (nothing deleted)
export async function deleteAnnouncementInTransaction(c: Queryable, id: number): Promise<void> {
  // The announcement first: if it does not exist, nothing is deleted.
  const { rowCount } = await c.query(`DELETE FROM announcements WHERE id = $1`, [id]);
  if (rowCount === 0) throw NOT_FOUND();

  // Then its notifications, for every user: the exact key only (no LIKE, so
  // 'announcement:12' is never caught when deleting announcement 1).
  await c.query(`DELETE FROM notifications WHERE dedup_key = $1`, [announcementKey(id)]);
}

// Deletes an announcement and its notifications, all or nothing.
export async function deleteAnnouncement(db: Db, id: number): Promise<void> {
  return inTransaction(db, (c) => deleteAnnouncementInTransaction(c, id));
}

// ---- Editing (Claude) ----

// Any of the four fields; the ones left out keep their value. The route checks that at
// least one is given, and title and body as when posting.
export type AnnouncementChanges = Partial<NewAnnouncement>;

// Edits an announcement and sets updated_at; never notifies again (section 3). The
// existing notifications stay as they are: they never repeated the text.
//   404 announcement_not_found  "That announcement does not exist."
export async function updateAnnouncement(
  db: Queryable,
  id: number,
  changes: AnnouncementChanges,
): Promise<Announcement> {
  const { rows } = await db.query<Announcement>(
    `UPDATE announcements
     SET title = coalesce($2, title),
         body = coalesce($3, body),
         is_urgent = coalesce($4, is_urgent),
         is_pinned = coalesce($5, is_pinned),
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, changes.title ?? null, changes.body ?? null, changes.isUrgent ?? null, changes.isPinned ?? null],
  );
  if (rows.length === 0) throw NOT_FOUND();
  return rows[0];
}

// ---- Reading (Claude) ----

// One page of announcements, pinned first, then newest (section 5), ties by id (newest
// first); and how many there are in all. The same list for the owner and the students.
// `page` starts at 1; the route checks page and limit. A page past the end is empty.
export async function listAnnouncements(
  db: Queryable,
  page: { page: number; limit: number },
): Promise<{ items: Announcement[]; total: number }> {
  const { rows: counted } = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM announcements`);
  const { rows } = await db.query<Announcement>(
    `SELECT ${COLUMNS}
     FROM announcements
     ORDER BY is_pinned DESC, created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [page.limit, (page.page - 1) * page.limit],
  );
  return { items: rows, total: counted[0].total };
}

// ---- Helper ----

// Runs `fn` in one transaction on its own client: COMMIT when it returns, ROLLBACK when
// it throws (the error is passed on), and the client always goes back to the pool.
async function inTransaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  try {
    await c.query("BEGIN");
    transactionStarted = true;
    const result = await fn(c);
    await c.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

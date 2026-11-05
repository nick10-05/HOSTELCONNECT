import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { listNotifications, markAllRead, markRead } from "../src/services/notifications";
import { insertOwner, testPool } from "./helpers/db";

// The bell's services (Claude): listNotifications, markRead and markAllRead. Every test
// makes its own people, and each person only ever sees their own notifications.
const db = testPool();
afterAll(() => db.end());

// Who owns the bell in these tests. These services treat every role alike, and these
// tests count every notification a person has, so the people must be ones no other test
// file can notify while this one runs: a broadcast to "active_students" (notify today,
// announcements on day 7) reaches every active student in the shared test database, but
// never an owner. (A student here once received tests/notify.test.ts's broadcast.)
const person = () => insertOwner(db);

// A notification for `user`, written straight to the table, `minutesAgo` old.
async function add(user: number, title: string, minutesAgo = 0, read = false): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO notifications (user_id, type, title, created_at, read_at)
     VALUES ($1, 'announcement', $2, now() - make_interval(mins => $3), CASE WHEN $4 THEN now() END)
     RETURNING id`,
    [user, title, minutesAgo, read],
  );
  return rows[0].id;
}

const readAt = async (id: number) =>
  (await db.query<{ read_at: Date | null }>("SELECT read_at FROM notifications WHERE id = $1", [id])).rows[0].read_at;

describe("listNotifications", () => {
  it("lists only the person's own notifications, newest first, with the total and the unread count", async () => {
    const me = await person();
    const someoneElse = await person();
    const old = await add(me, "Old notice", 60, true);
    const recent = await add(me, "Recent notice", 5);
    const newest = await add(me, "Newest notice", 1);
    await add(someoneElse, "Not mine");

    const result = await listNotifications(db, me, { page: 1, limit: 20 });

    expect(result.total).toBe(3);
    expect(result.unread).toBe(2);
    expect(result.items.map((n) => n.id)).toEqual([newest, recent, old]);
    expect(result.items[0]).toEqual({
      id: newest,
      type: "announcement",
      title: "Newest notice",
      body: null,
      link: null,
      createdAt: expect.any(Date),
      readAt: null,
    });
    expect(result.items[2].readAt).toBeInstanceOf(Date);
  });

  it("pages, and counts all of them on every page", async () => {
    const me = await person();
    for (let i = 0; i < 5; i += 1) await add(me, `Notice ${i}`, i);

    const first = await listNotifications(db, me, { page: 1, limit: 2 });
    const third = await listNotifications(db, me, { page: 3, limit: 2 });

    expect(first.items.map((n) => n.title)).toEqual(["Notice 0", "Notice 1"]);
    expect(third.items.map((n) => n.title)).toEqual(["Notice 4"]);
    expect(third).toMatchObject({ total: 5, unread: 5 });
  });

  it("answers an empty list for someone with no notifications", async () => {
    expect(await listNotifications(db, await person(), { page: 1, limit: 20 })).toEqual({
      items: [],
      total: 0,
      unread: 0,
    });
  });
});

describe("markRead", () => {
  it("marks one of the person's own notifications read, and keeps the first time on a second read", async () => {
    const me = await person();
    const id = await add(me, "Read me");

    await markRead(db, me, id);
    const first = await readAt(id);
    await markRead(db, me, id);

    expect(first).toBeInstanceOf(Date);
    expect(await readAt(id)).toEqual(first);
  });

  it("answers someone else's notification exactly like one that does not exist", async () => {
    const me = await person();
    const theirs = await add(await person(), "Not yours");

    const errors = await Promise.all([
      markRead(db, me, theirs).catch((e: unknown) => e),
      markRead(db, me, 999_999_999).catch((e: unknown) => e),
    ]);

    for (const err of errors) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 404, code: "notification_not_found" });
    }
    expect((errors[0] as HttpError).message).toBe((errors[1] as HttpError).message);
    expect(await readAt(theirs)).toBeNull();
  });
});

describe("markAllRead", () => {
  it("marks all of the person's unread notifications read, says how many, and touches nobody else's", async () => {
    const me = await person();
    const other = await person();
    const alreadyRead = await add(me, "Seen", 10, true);
    const before = await readAt(alreadyRead);
    await add(me, "Unseen 1");
    await add(me, "Unseen 2");
    const theirs = await add(other, "Theirs");

    expect(await markAllRead(db, me)).toBe(2);

    expect((await listNotifications(db, me, { page: 1, limit: 20 })).unread).toBe(0);
    expect(await readAt(alreadyRead)).toEqual(before);
    expect(await readAt(theirs)).toBeNull();
    expect(await markAllRead(db, me)).toBe(0);
  });
});

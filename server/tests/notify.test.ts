import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { notify } from "../src/services/notifications";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// notify in src/services/notifications.ts (you write it). Rows are committed, so every
// test uses its own title (or key) and looks only at its own rows: other test files add
// students and notifications at the same time.
const db = testPool();
afterAll(() => db.end());

const title = () => `Water off on Sunday ${randomUUID().slice(0, 8)}`;

async function rowsWithTitle(t: string) {
  const { rows } = await db.query(
    `SELECT user_id, type, title, body, link, dedup_key, read_at
     FROM notifications WHERE title = $1 ORDER BY user_id`,
    [t],
  );
  return rows;
}

describe("notify", () => {
  it("creates one unread notification per person, and says how many", async () => {
    const a = await insertStudent(db);
    const b = await insertStudent(db);
    const t = title();

    const created = await notify(db, [a, b], {
      type: "complaint_update",
      title: t,
      body: "Your complaint is now in progress.",
      link: "/complaints/42",
    });

    expect(created).toBe(2);
    expect(await rowsWithTitle(t)).toEqual(
      [a, b].map((user_id) => ({
        user_id,
        type: "complaint_update",
        title: t,
        body: "Your complaint is now in progress.",
        link: "/complaints/42",
        dedup_key: null,
        read_at: null,
      })),
    );
  });

  it("leaves body and link empty when they are not given", async () => {
    const a = await insertStudent(db);
    const t = title();

    await notify(db, [a], { type: "announcement", title: t });

    expect(await rowsWithTitle(t)).toMatchObject([{ body: null, link: null, dedup_key: null }]);
  });

  // A broadcast reaches every active student in the shared test database, including the
  // people other test files are creating at the same moment (files run in parallel).
  // Committed, it once landed in tests/notifications.test.ts's paging test. So it runs in
  // a transaction that is rolled back: other connections never see its rows.
  it("reaches every active student, and no former student or owner", () =>
    inRollback(db, async (c) => {
      const current = await insertStudent(c);
      const alsoCurrent = await insertStudent(c);
      const former = await insertStudent(c, { isActive: false });
      const owner = await insertOwner(c);
      const t = title();

      const created = await notify(c, "active_students", { type: "announcement", title: t });

      // Read on the same connection: the rows exist only inside this transaction.
      const { rows } = await c.query<{ user_id: number }>("SELECT user_id FROM notifications WHERE title = $1", [t]);
      const reached = rows.map((r) => r.user_id);
      expect(created).toBe(reached.length);
      expect(reached).toContain(current);
      expect(reached).toContain(alsoCurrent);
      expect(reached).not.toContain(former);
      expect(reached).not.toContain(owner);
    }));

  it("skips former students and unknown ids in a list, and may notify the owner", async () => {
    const current = await insertStudent(db);
    const former = await insertStudent(db, { isActive: false });
    const owner = await insertOwner(db);
    const formerOwner = await insertOwner(db, { isActive: false });
    const t = title();

    const created = await notify(db, [current, former, owner, formerOwner, 999_999_999], {
      type: "daily_digest",
      title: t,
    });

    expect(created).toBe(2);
    expect((await rowsWithTitle(t)).map((r) => r.user_id)).toEqual([current, owner].sort((x, y) => x - y));
  });

  it("does nothing, and fails nothing, for an empty list", async () => {
    expect(await notify(db, [], { type: "announcement", title: title() })).toBe(0);
  });

  it("notifies a person once per dedup key, even when called again", async () => {
    const a = await insertStudent(db);
    const b = await insertStudent(db);
    const key = `fee:${randomUUID()}:due`;
    const t = title();

    expect(await notify(db, [a], { type: "fee_reminder", title: t, dedupKey: key })).toBe(1);
    // Again for a (skipped) and now also for b (created).
    expect(await notify(db, [a, b], { type: "fee_reminder", title: t, dedupKey: key })).toBe(1);
    expect(await notify(db, [a, b], { type: "fee_reminder", title: t, dedupKey: key })).toBe(0);

    expect((await rowsWithTitle(t)).map((r) => [r.user_id, r.dedup_key])).toEqual([
      [a, key],
      [b, key],
    ]);
  });

  it("sends the same text again when there is no dedup key", async () => {
    const a = await insertStudent(db);
    const t = title();

    await notify(db, [a], { type: "announcement", title: t });
    await notify(db, [a], { type: "announcement", title: t });

    expect(await rowsWithTitle(t)).toHaveLength(2);
  });

  it("belongs to the caller's transaction: a rollback removes the notification too", async () => {
    const a = await insertStudent(db);
    const t = title();

    await inRollback(db, async (c) => {
      expect(await notify(c, [a], { type: "complaint_update", title: t })).toBe(1);
      const { rows } = await c.query("SELECT count(*)::int AS n FROM notifications WHERE title = $1", [t]);
      expect(rows[0].n).toBe(1);
    });

    expect(await rowsWithTitle(t)).toEqual([]);
  });
});

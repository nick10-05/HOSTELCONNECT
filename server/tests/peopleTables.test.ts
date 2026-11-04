import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for rejoin requests and notifications
// (migration 008), so they hold even if a service function has a bug. Run as hostel_app,
// the role the app uses, inside transactions that are rolled back.
const db = testPool();
afterAll(() => db.end());

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

async function one(c: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ id: number }>(sql, params);
  return rows[0].id;
}

const request = (c: PoolClient, student: number, message: string | null = null) =>
  one(c, "INSERT INTO rejoin_requests (student_id, message) VALUES ($1, $2) RETURNING id", [student, message]);

const DECIDE = `UPDATE rejoin_requests SET status = $1, decided_at = now(), decided_by = $2 WHERE id = $3`;

type NotificationFields = { user: number; type?: string; title?: string; body?: string; link?: string; dedupKey?: string };
const NOTIFY = `INSERT INTO notifications (user_id, type, title, body, link, dedup_key)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
const notifyParams = (n: NotificationFields) => [
  n.user,
  n.type ?? "announcement",
  n.title ?? "Water off on Sunday",
  n.body ?? null,
  n.link ?? null,
  n.dedupKey ?? null,
];

describe("rejoin requests", () => {
  it("records a request as pending, with an optional message", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c, { isActive: false });
      const id = await request(c, student, "I am back in town from June.");
      const { rows } = await c.query("SELECT status, decided_at, decided_by FROM rejoin_requests WHERE id = $1", [id]);
      expect(rows[0]).toEqual({ status: "pending", decided_at: null, decided_by: null });
      await request(c, await insertStudent(c, { isActive: false }));
    }));

  it("allows one pending request per student, and a new one after a decision", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c, { isActive: false });
      const first = await request(c, student);

      const second = await pgError(c, "INSERT INTO rejoin_requests (student_id) VALUES ($1)", [student]);
      expect(second).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "rejoin_requests_one_pending" });

      await c.query(DECIDE, ["rejected", owner, first]);
      await request(c, student);
    }));

  it("refuses an empty or over-long message", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c, { isActive: false });
      for (const message of ["", "x".repeat(501)]) {
        const err = await pgError(c, "INSERT INTO rejoin_requests (student_id, message) VALUES ($1, $2)", [
          student,
          message,
        ]);
        expect(err.code, `message of ${message.length}`).toBe(CHECK_VIOLATION);
      }
      await request(c, student, "x".repeat(500));
    }));

  it("needs both the decision time and the decider once decided, and neither while pending", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await request(c, await insertStudent(c, { isActive: false }));

      for (const [sql, params] of [
        ["UPDATE rejoin_requests SET status = 'approved' WHERE id = $1", [id]],
        ["UPDATE rejoin_requests SET status = 'approved', decided_at = now() WHERE id = $1", [id]],
        ["UPDATE rejoin_requests SET status = 'approved', decided_by = $2 WHERE id = $1", [id, owner]],
        ["UPDATE rejoin_requests SET decided_at = now(), decided_by = $2 WHERE id = $1", [id, owner]],
        ["UPDATE rejoin_requests SET status = 'maybe', decided_at = now(), decided_by = $2 WHERE id = $1", [id, owner]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(CHECK_VIOLATION);
      }
      await c.query(DECIDE, ["approved", owner, id]);
    }));

  it("is history: the app cannot delete a request or change who asked or what they wrote", () =>
    inRollback(db, async (c) => {
      const id = await request(c, await insertStudent(c, { isActive: false }), "Please let me back.");
      const someoneElse = await insertStudent(c, { isActive: false });

      for (const [sql, params] of [
        ["DELETE FROM rejoin_requests WHERE id = $1", [id]],
        ["UPDATE rejoin_requests SET student_id = $2 WHERE id = $1", [id, someoneElse]],
        ["UPDATE rejoin_requests SET message = 'changed' WHERE id = $1", [id]],
        ["UPDATE rejoin_requests SET created_at = now() WHERE id = $1", [id]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

describe("notifications", () => {
  it("stores a notification for a person, unread", () =>
    inRollback(db, async (c) => {
      const user = await insertStudent(c);
      const id = await one(c, NOTIFY, notifyParams({ user, body: "From 9 to 12.", link: "/announcements/3" }));
      const { rows } = await c.query("SELECT type, title, body, link, read_at FROM notifications WHERE id = $1", [id]);
      expect(rows[0]).toEqual({
        type: "announcement",
        title: "Water off on Sunday",
        body: "From 9 to 12.",
        link: "/announcements/3",
        read_at: null,
      });
    }));

  it("accepts the six types from the design, and nothing else", () =>
    inRollback(db, async (c) => {
      const user = await insertStudent(c);
      for (const type of ["announcement", "return_poll", "complaint_update", "fee_reminder", "payment_update", "daily_digest"]) {
        await one(c, NOTIFY, notifyParams({ user, type }));
      }
      const err = await pgError(c, NOTIFY, notifyParams({ user, type: "rejoin_request" }));
      expect(err.code).toBe(CHECK_VIOLATION);
    }));

  it("refuses an empty or over-long title and an over-long body", () =>
    inRollback(db, async (c) => {
      const user = await insertStudent(c);
      for (const n of [{ title: "   " }, { title: "x".repeat(121) }, { body: "x".repeat(501) }]) {
        const err = await pgError(c, NOTIFY, notifyParams({ user, ...n }));
        expect(err.code, JSON.stringify(n).slice(0, 40)).toBe(CHECK_VIOLATION);
      }
      await one(c, NOTIFY, notifyParams({ user, title: "x".repeat(120), body: "x".repeat(500) }));
    }));

  it("only links inside the app", () =>
    inRollback(db, async (c) => {
      const user = await insertStudent(c);
      for (const link of ["/", "/complaints/42", "/fees?month=2026-11"]) {
        await one(c, NOTIFY, notifyParams({ user, link }));
      }
      for (const link of ["https://elsewhere.example", "//elsewhere.example", "/\\elsewhere.example", "complaints/42", ""]) {
        const err = await pgError(c, NOTIFY, notifyParams({ user, link }));
        expect(err.code, link).toBe(CHECK_VIOLATION);
      }
    }));

  it("creates a deduplicated event once per person, but for each person", () =>
    inRollback(db, async (c) => {
      const a = await insertStudent(c);
      const b = await insertStudent(c);
      const key = "fee:2026-11-14:due";
      await one(c, NOTIFY, notifyParams({ user: a, type: "fee_reminder", dedupKey: key }));
      await one(c, NOTIFY, notifyParams({ user: b, type: "fee_reminder", dedupKey: key }));

      const again = await pgError(c, NOTIFY, notifyParams({ user: a, type: "fee_reminder", dedupKey: key }));
      expect(again).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "notifications_user_dedup_key" });
      // Without a key, the same text may arrive any number of times.
      await one(c, NOTIFY, notifyParams({ user: a }));
      await one(c, NOTIFY, notifyParams({ user: a }));
    }));

  it("can be marked read and deleted by the app, but not rewritten", () =>
    inRollback(db, async (c) => {
      const user = await insertStudent(c);
      const id = await one(c, NOTIFY, notifyParams({ user }));
      await c.query("UPDATE notifications SET read_at = now() WHERE id = $1", [id]);

      for (const sql of [
        "UPDATE notifications SET title = 'changed' WHERE id = $1",
        "UPDATE notifications SET user_id = user_id WHERE id = $1",
        "UPDATE notifications SET created_at = now() WHERE id = $1",
      ]) {
        const err = await pgError(c, sql, [id]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await c.query("DELETE FROM notifications WHERE id = $1", [id]);
    }));
});

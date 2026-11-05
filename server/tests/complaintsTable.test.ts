import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for complaints and their timeline (migration
// 009), so they hold even if a service function has a bug. Run as hostel_app, the role
// the app uses, inside transactions that are rolled back.
const db = testPool();
afterAll(() => db.end());

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

const CATEGORIES = ["plumbing", "electrical", "cleanliness", "internet", "food", "furniture", "security", "other"];
const TEXT = "The tap in room 101 keeps dripping all night.";

async function one(c: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ id: number }>(sql, params);
  return rows[0].id;
}

const COMPLAIN = `INSERT INTO complaints (student_id, category, description) VALUES ($1, $2, $3) RETURNING id`;
const complain = (c: PoolClient, student: number, category = "plumbing", description = TEXT) =>
  one(c, COMPLAIN, [student, category, description]);

const setStatus = (c: PoolClient, id: number, status: string) =>
  c.query(
    `UPDATE complaints SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END WHERE id = $1`,
    [id, status],
  );

type EventFields = { kind?: string; note?: string | null; from?: string | null; to?: string | null };
const EVENT = `INSERT INTO complaint_events (complaint_id, actor_id, kind, note, from_status, to_status)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
const eventParams = (complaint: number, actor: number, e: EventFields = {}) => [
  complaint,
  actor,
  e.kind ?? "created",
  e.note ?? null,
  e.from ?? null,
  e.to ?? null,
];

const PHOTO = `INSERT INTO complaints (student_id, category, description,
                 photo_path, photo_size_bytes, photo_expires_at, photo_deleted_at)
               VALUES ($1, 'plumbing', $2, $3, $4, $5, $6) RETURNING id`;

describe("complaints", () => {
  it("records a new complaint as open, normal priority, with no photo", () =>
    inRollback(db, async (c) => {
      const id = await complain(c, await insertStudent(c));
      const { rows } = await c.query(
        `SELECT status, priority, resolved_at, photo_path, photo_size_bytes, photo_expires_at,
                photo_deleted_at, photo_delete_attempts
           FROM complaints WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        status: "open",
        priority: "normal",
        resolved_at: null,
        photo_path: null,
        photo_size_bytes: null,
        photo_expires_at: null,
        photo_deleted_at: null,
        photo_delete_attempts: 0,
      });
    }));

  it("accepts the eight categories from the design, and nothing else", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      for (const category of CATEGORIES) await complain(c, student, category);
      for (const category of ["water", "Plumbing", ""]) {
        const err = await pgError(c, COMPLAIN, [student, category, TEXT]);
        expect(err.code, category).toBe(CHECK_VIOLATION);
      }
    }));

  it("takes a description of 10 to 500 characters, stored trimmed", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const tooShort = "x".repeat(9);
      for (const description of [
        tooShort,
        "x".repeat(501),
        "          ", // ten spaces
        "\n\n\n\n\n\n\n\n\n\n",
        ` ${TEXT}`, // not trimmed
        `${TEXT}\n`,
        `${TEXT}\t`,
        `${tooShort}\r\n`, // 9 characters once trimmed
      ]) {
        const err = await pgError(c, COMPLAIN, [student, "other", description]);
        expect(err.code, JSON.stringify(description).slice(0, 30)).toBe(CHECK_VIOLATION);
      }
      // Spaces and line breaks inside the text are kept and counted.
      const categories = CATEGORIES.values();
      for (const description of ["x".repeat(10), "x".repeat(500), "Fan broken.\n\nRoom 204, since Monday."]) {
        await complain(c, student, categories.next().value, description);
      }
    }));

  it("accepts the four statuses and three priorities, and nothing else", () =>
    inRollback(db, async (c) => {
      const id = await complain(c, await insertStudent(c));
      for (const status of ["in_progress", "rejected", "open", "resolved"]) await setStatus(c, id, status);
      for (const priority of ["low", "high", "normal"]) {
        await c.query("UPDATE complaints SET priority = $2 WHERE id = $1", [id, priority]);
      }
      for (const [sql, value] of [
        ["UPDATE complaints SET status = $2 WHERE id = $1", "closed"],
        ["UPDATE complaints SET priority = $2 WHERE id = $1", "urgent"],
      ] as const) {
        const err = await pgError(c, sql, [id, value]);
        expect(err.code, value).toBe(CHECK_VIOLATION);
      }
    }));

  it("has a resolved time exactly while resolved", () =>
    inRollback(db, async (c) => {
      const id = await complain(c, await insertStudent(c));
      for (const sql of [
        "UPDATE complaints SET status = 'resolved' WHERE id = $1",
        "UPDATE complaints SET resolved_at = now() WHERE id = $1",
        "UPDATE complaints SET status = 'rejected', resolved_at = now() WHERE id = $1",
      ]) {
        const err = await pgError(c, sql, [id]);
        expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "complaints_resolved_at" });
      }
      await setStatus(c, id, "resolved");
      // Reopening must clear it.
      const reopen = await pgError(c, "UPDATE complaints SET status = 'open' WHERE id = $1", [id]);
      expect(reopen).toMatchObject({ code: CHECK_VIOLATION, constraint: "complaints_resolved_at" });
      await setStatus(c, id, "open");
    }));

  it("allows one active complaint per category for each student", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const first = await complain(c, student, "plumbing");

      const second = await pgError(c, COMPLAIN, [student, "plumbing", TEXT]);
      expect(second).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "complaints_one_active_per_category" });

      // In progress is still active.
      await setStatus(c, first, "in_progress");
      const third = await pgError(c, COMPLAIN, [student, "plumbing", TEXT]);
      expect(third).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "complaints_one_active_per_category" });

      // Another category, or another student, is not affected.
      await complain(c, student, "electrical");
      await complain(c, await insertStudent(c), "plumbing");
    }));

  it("frees the category once a complaint is resolved or rejected, and refuses reopening a duplicate", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const resolved = await complain(c, student, "internet");
      await setStatus(c, resolved, "resolved");
      const rejected = await complain(c, student, "internet");
      await setStatus(c, rejected, "rejected");
      await complain(c, student, "internet");

      // With a new active one in the category, the old one cannot become active again.
      for (const id of [resolved, rejected]) {
        const err = await pgError(c, "UPDATE complaints SET status = 'open', resolved_at = NULL WHERE id = $1", [id]);
        expect(err).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "complaints_one_active_per_category" });
      }
    }));

  it("keeps the photo's path, size and expiry together, and deletes only an existing photo", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const path = "complaints/3f1c9a.jpg";
      const expires = "2026-11-07T10:00:00Z";
      const deleted = "2026-11-07T10:30:00Z";

      for (const [label, ...photo] of [
        ["path only", path, null, null, null],
        ["no expiry", path, 400_000, null, null],
        ["no path", null, 400_000, expires, null],
        ["deleted without a photo", null, null, null, deleted],
        ["zero bytes", path, 0, expires, null],
        ["blank path", "   ", 400_000, expires, null],
      ] as const) {
        const err = await pgError(c, PHOTO, [student, TEXT, ...photo]);
        expect(err.code, label).toBe(CHECK_VIOLATION);
      }

      const id = await one(c, PHOTO, [student, TEXT, path, 400_000, expires, null]);
      await c.query(
        "UPDATE complaints SET photo_delete_attempts = photo_delete_attempts + 1 WHERE id = $1",
        [id],
      );
      await c.query("UPDATE complaints SET photo_deleted_at = $2 WHERE id = $1", [id, deleted]);
      const negative = await pgError(c, "UPDATE complaints SET photo_delete_attempts = -1 WHERE id = $1", [id]);
      expect(negative.code).toBe(CHECK_VIOLATION);
    }));

  it("is permanent: the app cannot delete a complaint or change who raised it or what it says", () =>
    inRollback(db, async (c) => {
      const id = await complain(c, await insertStudent(c));
      const someoneElse = await insertStudent(c);

      for (const [sql, params] of [
        ["DELETE FROM complaints WHERE id = $1", [id]],
        ["UPDATE complaints SET student_id = $2 WHERE id = $1", [id, someoneElse]],
        ["UPDATE complaints SET category = 'food' WHERE id = $1", [id]],
        ["UPDATE complaints SET description = 'Changed afterwards.' WHERE id = $1", [id]],
        ["UPDATE complaints SET created_at = now() WHERE id = $1", [id]],
        ["UPDATE complaints SET photo_path = 'complaints/other.jpg' WHERE id = $1", [id]],
        ["UPDATE complaints SET photo_size_bytes = 1 WHERE id = $1", [id]],
        ["UPDATE complaints SET photo_expires_at = now() WHERE id = $1", [id]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      // The owner's fields can change.
      await c.query("UPDATE complaints SET priority = 'high', updated_at = now() WHERE id = $1", [id]);
    }));
});

describe("complaint events", () => {
  it("records the timeline: created, a status change and a note", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const owner = await insertOwner(c);
      const id = await complain(c, student);

      await one(c, EVENT, eventParams(id, student, { kind: "created" }));
      await one(c, EVENT, eventParams(id, owner, { kind: "status_change", from: "open", to: "in_progress" }));
      await one(c, EVENT, eventParams(id, owner, { kind: "note", note: "Plumber booked for Friday." }));

      const { rows } = await c.query(
        "SELECT kind, note, from_status, to_status FROM complaint_events WHERE complaint_id = $1 ORDER BY id",
        [id],
      );
      expect(rows).toEqual([
        { kind: "created", note: null, from_status: null, to_status: null },
        { kind: "status_change", note: null, from_status: "open", to_status: "in_progress" },
        { kind: "note", note: "Plumber booked for Friday.", from_status: null, to_status: null },
      ]);
    }));

  it("accepts the three kinds and four statuses, and nothing else", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await complain(c, await insertStudent(c));
      for (const e of [
        { kind: "reply" },
        { kind: "status_change", to: "closed" },
        { kind: "status_change", from: "waiting", to: "open" },
      ]) {
        const err = await pgError(c, EVENT, eventParams(id, owner, e));
        expect(err.code, JSON.stringify(e)).toBe(CHECK_VIOLATION);
      }
    }));

  it("needs a new status for a status change, a note for a note, and a note to reject", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await complain(c, await insertStudent(c));
      for (const [e, constraint] of [
        [{ kind: "status_change", from: "open" }, "complaint_events_status_change_has_to_status"],
        [{ kind: "note" }, "complaint_events_note_has_note"],
        [{ kind: "status_change", from: "open", to: "rejected" }, "complaint_events_reject_has_note"],
      ] as const) {
        const err = await pgError(c, EVENT, eventParams(id, owner, e));
        expect(err, constraint).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
      const blank = await pgError(c, EVENT, eventParams(id, owner, { kind: "note", note: "   " }));
      expect(blank.code).toBe(CHECK_VIOLATION);

      await one(c, EVENT, eventParams(id, owner, {
        kind: "status_change",
        from: "open",
        to: "rejected",
        note: "Duplicate of #41.",
      }));
    }));

  // Migration 010 (day 7): the owner's notes, as the services store them.
  it("keeps a note at most 500 characters, counted as characters, and stored trimmed", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await complain(c, await insertStudent(c));
      for (const [label, note, constraint] of [
        ["501 characters", "x".repeat(501), "complaint_events_note_length"],
        ["501 emoji", "🚿".repeat(501), "complaint_events_note_length"],
        ["leading space", " Plumber booked.", "complaint_events_note_trimmed"],
        ["trailing line break", "Plumber booked.\n", "complaint_events_note_trimmed"],
        ["trailing tab", "Plumber booked.\t", "complaint_events_note_trimmed"],
      ] as const) {
        const err = await pgError(c, EVENT, eventParams(id, owner, { kind: "note", note }));
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
      // 500 characters (an emoji is one), and line breaks inside the note, are fine.
      for (const note of ["x".repeat(500), "🚿".repeat(500), "Plumber booked.\n\nComes on Friday."]) {
        await one(c, EVENT, eventParams(id, owner, { kind: "note", note }));
      }
      // The same rules hold for a note that comes with a status change.
      const err = await pgError(
        c,
        EVENT,
        eventParams(id, owner, { kind: "status_change", from: "open", to: "rejected", note: "x".repeat(501) }),
      );
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "complaint_events_note_length" });
    }));

  it("needs a note to reopen a resolved complaint (section 4)", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await complain(c, await insertStudent(c));
      const reopen = (note: string | null) =>
        eventParams(id, owner, { kind: "status_change", from: "resolved", to: "open", note });

      const err = await pgError(c, EVENT, reopen(null));
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "complaint_events_reopen_has_note" });
      await one(c, EVENT, reopen("Still leaking."));
      // Other moves still take no note.
      await one(c, EVENT, eventParams(id, owner, { kind: "status_change", from: "open", to: "in_progress" }));
      await one(c, EVENT, eventParams(id, owner, { kind: "status_change", from: "in_progress", to: "resolved" }));
    }));

  it("is history: the app cannot change or delete an event", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const id = await complain(c, student);
      const event = await one(c, EVENT, eventParams(id, student));

      for (const sql of [
        "DELETE FROM complaint_events WHERE id = $1",
        "UPDATE complaint_events SET note = 'changed' WHERE id = $1",
        "UPDATE complaint_events SET created_at = now() WHERE id = $1",
      ]) {
        const err = await pgError(c, sql, [event]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

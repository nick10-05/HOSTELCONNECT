import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { addComplaintNote, OWNER_NOTE_MAX, type ComplaintStatus } from "../src/services/complaints";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// addComplaintNote (you write it): the owner's one-way note, its timeline event and the
// student's notification in one transaction; every refusal writes nothing. Rows are
// committed, so each test makes its own students and looks only at their rows.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const TEXT = "The tap in room 101 keeps dripping all night.";

// A high-priority complaint raised (and last updated) two days ago, written straight to
// the table, so a test can see that a note leaves the priority alone.
async function addComplaint(student: number, status: ComplaintStatus = "open", category = "plumbing") {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, priority, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'high',
             CASE WHEN $4 = 'resolved' THEN now() - interval '47 hours' END,
             now() - interval '48 hours', now() - interval '48 hours')
     RETURNING id`,
    [student, category, TEXT, status],
  );
  return rows[0].id;
}

async function stateOf(id: number) {
  const { rows } = await db.query(
    `SELECT status, priority, resolved_at AS "resolvedAt", updated_at AS "updatedAt",
            updated_at > now() - interval '1 minute' AS "recentlyUpdated"
     FROM complaints WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const eventsOf = async (id: number) =>
  (
    await db.query(
      `SELECT kind, actor_id AS "actorId", from_status AS "from", to_status AS "to", note
       FROM complaint_events WHERE complaint_id = $1 ORDER BY id`,
      [id],
    )
  ).rows;

const notificationsOf = async (userId: number) =>
  (
    await db.query(
      `SELECT type, title, body, link, dedup_key AS "dedupKey"
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

describe("addComplaintNote", () => {
  it.each(["open", "in_progress", "resolved", "rejected"] as const)(
    "adds a note to a complaint that is %s, touching only updated_at",
    async (status) => {
      const owner = await insertOwner(db);
      const student = await insertStudent(db);
      const id = await addComplaint(student, status);
      const before = await stateOf(id);

      const detail = await addComplaintNote(db, owner, id, "  Plumber booked for Friday.\n");

      // Only updated_at moves: status, priority and resolved_at stay as they were.
      const after = await stateOf(id);
      expect(after.recentlyUpdated).toBe(true);
      expect({ ...after, updatedAt: null, recentlyUpdated: null }).toEqual({
        ...before,
        updatedAt: null,
        recentlyUpdated: null,
      });

      expect(await eventsOf(id)).toEqual([
        { kind: "note", actorId: owner, from: null, to: null, note: "Plumber booked for Friday." },
      ]);
      expect(await notificationsOf(student)).toEqual([
        {
          type: "complaint_update",
          title: "There is a new note on your plumbing complaint.",
          body: null,
          link: `/complaints/${id}`,
          dedupKey: null,
        },
      ]);
      expect(await notificationsOf(owner)).toEqual([]);

      expect(detail).toMatchObject({ id, status, priority: "high" });
      expect(detail.events).toEqual([
        expect.objectContaining({ kind: "note", note: "Plumber booked for Friday.", fromStatus: null, toStatus: null }),
      ]);
    },
  );

  it("names the complaint's own category, and adds a second note as a second event", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const id = await addComplaint(student, "open", "internet");

    await addComplaintNote(db, owner, id, "Router ordered.");
    await addComplaintNote(db, owner, id, "Router arrives tomorrow.");

    expect((await eventsOf(id)).map((e) => e.note)).toEqual(["Router ordered.", "Router arrives tomorrow."]);
    expect((await notificationsOf(student)).map((n) => n.title)).toEqual([
      "There is a new note on your internet complaint.",
      "There is a new note on your internet complaint.",
    ]);
  });

  it(`accepts ${OWNER_NOTE_MAX} characters, counted as the database counts them`, async () => {
    const owner = await insertOwner(db);
    const id = await addComplaint(await insertStudent(db));
    const emoji = "🚿".repeat(OWNER_NOTE_MAX); // 1000 UTF-16 units, 500 characters
    await addComplaintNote(db, owner, id, emoji);
    expect((await eventsOf(id))[0].note).toBe(emoji);
  });

  it("adds the note to a moved-out student's complaint without notifying them", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db, { isActive: false });
    const id = await addComplaint(student, "resolved");

    await addComplaintNote(db, owner, id, "Refund given in cash.");

    expect(await eventsOf(id)).toHaveLength(1);
    expect(await notificationsOf(student)).toEqual([]);
  });
});

describe("addComplaintNote: refusals write nothing", () => {
  it.each([
    { note: undefined, code: "note_required", message: "A note cannot be empty." },
    { note: null, code: "note_required", message: "A note cannot be empty." },
    { note: "", code: "note_required", message: "A note cannot be empty." },
    { note: " \t\n ", code: "note_required", message: "A note cannot be empty." },
    { note: "a".repeat(OWNER_NOTE_MAX + 1), code: "note_too_long", message: "A note can be at most 500 characters." },
    { note: "🚿".repeat(OWNER_NOTE_MAX + 1), code: "note_too_long", message: "A note can be at most 500 characters." },
  ])("refuses $code for $note", async ({ note, code, message }) => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const id = await addComplaint(student);
    const before = await stateOf(id);

    expect(await refusal(addComplaintNote(db, owner, id, note))).toEqual({ status: 400, code, message });

    expect(await stateOf(id)).toEqual(before);
    expect(await eventsOf(id)).toEqual([]);
    expect(await notificationsOf(student)).toEqual([]);
  });

  it("refuses a complaint that does not exist, after checking the note", async () => {
    const owner = await insertOwner(db);
    expect(await refusal(addComplaintNote(db, owner, MISSING, "Hello."))).toEqual({
      status: 404,
      code: "complaint_not_found",
      message: "That complaint does not exist.",
    });
    // The note is checked first, so a blank note on a missing complaint is a 400.
    expect(await refusal(addComplaintNote(db, owner, MISSING, "  "))).toMatchObject({ status: 400, code: "note_required" });
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  changeComplaintStatus,
  createComplaint,
  STATUS_MOVES,
  type ComplaintCategory,
  type ComplaintStatus,
} from "../src/services/complaints";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// changeComplaintStatus (you write it): the update, the timeline event and the student's
// notification in one transaction, every refusal writing nothing, and races. Rows are
// committed, because the races need real concurrent transactions, so each test makes its
// own students and looks only at their rows.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const TEXT = "The tap in room 101 keeps dripping all night.";

// A complaint raised two days ago (updated then too), written straight to the table.
async function addComplaint(student: number, category: ComplaintCategory, status: ComplaintStatus = "open") {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $4 = 'resolved' THEN now() - interval '47 hours' END,
             now() - interval '48 hours', now() - interval '48 hours')
     RETURNING id`,
    [student, category, TEXT, status],
  );
  return rows[0].id;
}

async function stateOf(id: number) {
  const { rows } = await db.query<{
    status: string;
    priority: string;
    updatedAt: Date;
    resolvedAt: Date | null;
    recentlyUpdated: boolean;
    recentlyResolved: boolean;
  }>(
    `SELECT status, priority, updated_at AS "updatedAt", resolved_at AS "resolvedAt",
            updated_at > now() - interval '1 minute' AS "recentlyUpdated",
            coalesce(resolved_at > now() - interval '1 minute', false) AS "recentlyResolved"
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

// A refused change must leave the complaint, its timeline and the student's bell as they were.
async function expectNothingWritten(id: number, student: number, call: () => Promise<unknown>) {
  const before = await stateOf(id);
  const result = await refusal(call());
  expect(await stateOf(id)).toEqual(before);
  expect(await eventsOf(id)).toEqual([]);
  expect(await notificationsOf(student)).toEqual([]);
  return result;
}

describe("changeComplaintStatus: each legal move", () => {
  it.each([
    { from: "open", to: "in_progress", title: "Your food complaint is now in progress." },
    { from: "open", to: "resolved", title: "Your food complaint is now resolved." },
    { from: "open", to: "rejected", title: "Your food complaint is now rejected." },
    { from: "in_progress", to: "resolved", title: "Your food complaint is now resolved." },
    { from: "in_progress", to: "rejected", title: "Your food complaint is now rejected." },
    { from: "resolved", to: "open", title: "Your food complaint was reopened." },
  ] as const)("$from -> $to writes the status, one event and one notification", async ({ from, to, title }) => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food", from);

    const detail = await changeComplaintStatus(db, owner, id, { from, to, note: "  Checked by the warden.  " });

    // The complaint: the new status, updated now, resolved_at set exactly while resolved.
    const state = await stateOf(id);
    expect(state.status).toBe(to);
    expect(state.recentlyUpdated).toBe(true);
    if (to === "resolved") expect(state.recentlyResolved).toBe(true);
    else expect(state.resolvedAt).toBeNull();
    expect(state.priority).toBe("normal");

    // The timeline: one status_change by the owner, with the trimmed note.
    expect(await eventsOf(id)).toEqual([
      { kind: "status_change", actorId: owner, from, to, note: "Checked by the warden." },
    ]);

    // The student's bell: one notification, without the note. Nothing for the owner.
    expect(await notificationsOf(student)).toEqual([
      { type: "complaint_update", title, body: null, link: `/complaints/${id}`, dedupKey: null },
    ]);
    expect(await notificationsOf(owner)).toEqual([]);

    // The answer is the owner's view after the change.
    expect(detail).toMatchObject({ id, status: to, priority: "normal" });
    expect([...detail.allowedMoves].sort()).toEqual([...STATUS_MOVES[to]].sort());
    expect(detail.events.map((e) => e.kind)).toEqual(["status_change"]);
  });

  it("stores no note when none is given, and an empty or blank note counts as none", async () => {
    const owner = await insertOwner(db);
    for (const note of [undefined, null, "", "   \n "]) {
      const student = await insertStudent(db);
      const id = await addComplaint(student, "internet");
      await changeComplaintStatus(db, owner, id, { from: "open", to: "in_progress", note });
      expect(await eventsOf(id), JSON.stringify(note)).toEqual([
        { kind: "status_change", actorId: owner, from: "open", to: "in_progress", note: null },
      ]);
    }
  });

  it("names the complaint's own category in the notification", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const id = await addComplaint(student, "electrical");
    await changeComplaintStatus(db, owner, id, { from: "open", to: "in_progress" });
    expect((await notificationsOf(student))[0].title).toBe("Your electrical complaint is now in progress.");
  });

  it("answers a moved-out student's complaint, without notifying them", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db, { isActive: false });
    const id = await addComplaint(student, "furniture");

    await changeComplaintStatus(db, owner, id, { from: "open", to: "resolved" });

    expect((await stateOf(id)).status).toBe("resolved");
    expect(await eventsOf(id)).toHaveLength(1);
    expect(await notificationsOf(student)).toEqual([]);
  });
});

describe("changeComplaintStatus: refusals write nothing", () => {
  it("refuses an illegal move, and a reject or reopen without a note", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const rejected = await addComplaint(student, "food", "rejected");
    const open = await addComplaint(student, "plumbing", "open");
    const resolved = await addComplaint(student, "internet", "resolved");

    expect(
      await expectNothingWritten(rejected, student, () =>
        changeComplaintStatus(db, owner, rejected, { from: "rejected", to: "open", note: "Sorry." }),
      ),
    ).toMatchObject({ status: 409, code: "illegal_transition" });
    expect(
      await expectNothingWritten(open, student, () =>
        changeComplaintStatus(db, owner, open, { from: "open", to: "rejected", note: "  " }),
      ),
    ).toMatchObject({ status: 400, code: "note_required" });
    expect(
      await expectNothingWritten(resolved, student, () =>
        changeComplaintStatus(db, owner, resolved, { from: "resolved", to: "open" }),
      ),
    ).toMatchObject({ status: 400, code: "note_required" });
  });

  it("refuses a complaint that does not exist", async () => {
    const owner = await insertOwner(db);
    expect(await refusal(changeComplaintStatus(db, owner, MISSING, { from: "open", to: "in_progress" }))).toEqual({
      status: 404,
      code: "complaint_not_found",
      message: "That complaint does not exist.",
    });
  });

  it("refuses when the status is no longer the one the owner saw", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const id = await addComplaint(student, "food", "in_progress");

    // The owner's screen still showed 'open'; open -> resolved is legal, in_progress is not 'open'.
    expect(
      await expectNothingWritten(id, student, () => changeComplaintStatus(db, owner, id, { from: "open", to: "resolved" })),
    ).toEqual({
      status: 409,
      code: "status_changed",
      message: "This complaint has changed since you opened it. Reload it and try again.",
    });
  });

  it("refuses to reopen when the student has a newer active complaint in the same category", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    const old = await addComplaint(student, "plumbing", "resolved");
    await addComplaint(student, "plumbing", "open");

    expect(
      await expectNothingWritten(old, student, () =>
        changeComplaintStatus(db, owner, old, { from: "resolved", to: "open", note: "Still leaking." }),
      ),
    ).toEqual({
      status: 409,
      code: "category_active",
      message: "The student already has an active plumbing complaint, so this one cannot be reopened.",
    });
  });
});

describe("changeComplaintStatus: races", () => {
  const ROUNDS = 5;

  it("lets only one of two changes from the same status through", async () => {
    const owner = await insertOwner(db);
    for (let round = 0; round < ROUNDS; round++) {
      const student = await insertStudent(db);
      const id = await addComplaint(student, "food");

      const results = await Promise.allSettled([
        changeComplaintStatus(db, owner, id, { from: "open", to: "in_progress" }),
        changeComplaintStatus(db, owner, id, { from: "open", to: "resolved" }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(lost.reason).toBeInstanceOf(HttpError);
      expect(lost.reason).toMatchObject({ status: 409, code: "status_changed" });
      expect(await eventsOf(id)).toHaveLength(1);
      expect(await notificationsOf(student)).toHaveLength(1);
    }
  });

  it("never leaves two active complaints in one category when a reopen races a new complaint", async () => {
    const owner = await insertOwner(db);
    for (let round = 0; round < ROUNDS; round++) {
      const student = await insertStudent(db);
      const old = await addComplaint(student, "plumbing", "resolved");

      const results = await Promise.allSettled([
        changeComplaintStatus(db, owner, old, { from: "resolved", to: "open", note: "Still leaking." }),
        createComplaint(db, student, { category: "plumbing", description: TEXT }, { maxActive: 3, maxNewPer24h: 2 }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      // A clean refusal from either side (409 for the reopen, 429 for the new one), never a 500.
      expect(lost.reason).toBeInstanceOf(HttpError);
      expect(lost.reason).toMatchObject({ code: "category_active" });
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM complaints
         WHERE student_id = $1 AND category = 'plumbing' AND status IN ('open', 'in_progress')`,
        [student],
      );
      expect(rows[0].n).toBe(1);
    }
  });
});

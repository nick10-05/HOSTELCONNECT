import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  getMyComplaint,
  listMyComplaints,
  setComplaintPriority,
  type ComplaintStatus,
} from "../src/services/complaints";
import { insertStudent, testPool } from "./helpers/db";

// setComplaintPriority (Claude): only the priority changes, and nothing the student could
// see. Rows are committed, so each test makes its own students and looks only at them.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const TEXT = "The tap in room 101 keeps dripping all night.";

// A normal-priority complaint raised (and last updated) two days ago.
async function addComplaint(student: number, status: ComplaintStatus = "open") {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at, created_at, updated_at)
     VALUES ($1, 'plumbing', $2, $3,
             CASE WHEN $3 = 'resolved' THEN now() - interval '47 hours' END,
             now() - interval '48 hours', now() - interval '48 hours')
     RETURNING id`,
    [student, TEXT, status],
  );
  return rows[0].id;
}

// Everything about the complaint except its priority, and the priority on its own.
async function stateOf(id: number) {
  const { rows } = await db.query(
    `SELECT priority, status, resolved_at AS "resolvedAt", updated_at AS "updatedAt",
            (SELECT count(*)::int FROM complaint_events WHERE complaint_id = c.id) AS events
     FROM complaints c WHERE id = $1`,
    [id],
  );
  const { priority, ...rest } = rows[0];
  return { priority, rest };
}

const notificationCount = async (userId: number) =>
  (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [userId]))
    .rows[0].n;

describe("setComplaintPriority", () => {
  it.each(["high", "low", "normal"] as const)("sets %s and changes nothing else", async (priority) => {
    const student = await insertStudent(db);
    const id = await addComplaint(student);
    const before = await stateOf(id);

    const detail = await setComplaintPriority(db, id, priority);

    const after = await stateOf(id);
    expect(after.priority).toBe(priority);
    // Status, resolved_at, updated_at and the timeline are exactly as before.
    expect(after.rest).toEqual(before.rest);
    expect(await notificationCount(student)).toBe(0);
    expect(detail).toMatchObject({ id, priority, status: "open" });
    expect(detail.events).toEqual([]);
  });

  it.each(["resolved", "rejected", "in_progress"] as const)("works on a complaint that is %s", async (status) => {
    const id = await addComplaint(await insertStudent(db), status);
    const before = await stateOf(id);

    await setComplaintPriority(db, id, "high");

    const after = await stateOf(id);
    expect(after.priority).toBe("high");
    expect(after.rest).toEqual(before.rest);
  });

  it("accepts the priority the complaint already has, and the last change wins", async () => {
    const id = await addComplaint(await insertStudent(db));
    await setComplaintPriority(db, id, "normal");
    expect((await stateOf(id)).priority).toBe("normal");
    await setComplaintPriority(db, id, "high");
    await setComplaintPriority(db, id, "low");
    expect((await stateOf(id)).priority).toBe("low");
  });

  it("refuses a complaint that does not exist", async () => {
    const err = await setComplaintPriority(db, MISSING, "high").then(
      () => {
        throw new Error("expected a refusal, but it succeeded");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    const { status, code, message } = err as HttpError;
    expect({ status, code, message }).toEqual({
      status: 404,
      code: "complaint_not_found",
      message: "That complaint does not exist.",
    });
  });

  it("stays invisible to the student after a real change", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student);
    const listBefore = await listMyComplaints(db, student, { page: 1, limit: 20 });
    const detailBefore = await getMyComplaint(db, student, id);

    await setComplaintPriority(db, id, "high");

    // The student's list and detail are identical, field for field, and have no priority.
    const listAfter = await listMyComplaints(db, student, { page: 1, limit: 20 });
    const detailAfter = await getMyComplaint(db, student, id);
    expect(listAfter).toEqual(listBefore);
    expect(detailAfter).toEqual(detailBefore);
    expect(detailAfter).not.toHaveProperty("priority");
  });
});

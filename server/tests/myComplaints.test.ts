import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { getMyComplaint, listMyComplaints } from "../src/services/complaints";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// A student's own complaints: listMyComplaints and getMyComplaint (you write them), with
// the ownership filter. Rows are committed and written straight to the tables, so each
// test makes its own students and looks only at them.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const PAGE = { page: 1, limit: 20 };
const ITEM_FIELDS = ["category", "createdAt", "description", "id", "resolvedAt", "status", "updatedAt"];
const EVENT_FIELDS = ["createdAt", "fromStatus", "kind", "note", "toStatus"];

// A complaint at a given time (and an optional status), written straight to the table.
async function addComplaint(
  student: number,
  opts: { category?: string; description?: string; status?: string; createdAt?: string } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'resolved' THEN now() END,
             coalesce($5::timestamptz, now()), coalesce($5::timestamptz, now()))
     RETURNING id`,
    [
      student,
      opts.category ?? "plumbing",
      opts.description ?? "The tap in room 101 keeps dripping all night.",
      opts.status ?? "open",
      opts.createdAt ?? null,
    ],
  );
  return rows[0].id;
}

async function addEvent(
  complaint: number,
  actor: number,
  e: { kind: string; note?: string; from?: string; to?: string; at: string },
): Promise<void> {
  await db.query(
    `INSERT INTO complaint_events (complaint_id, actor_id, kind, note, from_status, to_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [complaint, actor, e.kind, e.note ?? null, e.from ?? null, e.to ?? null, e.at],
  );
}

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

const NOT_FOUND = { status: 404, code: "complaint_not_found", message: "That complaint does not exist." };

describe("listMyComplaints", () => {
  it("lists the student's complaints newest first, with exactly the student's fields", async () => {
    const student = await insertStudent(db);
    const older = await addComplaint(student, { category: "food", createdAt: "2026-11-01T09:00:00+05:30" });
    const newer = await addComplaint(student, {
      category: "internet",
      description: "Wi-Fi drops every evening on the second floor.",
      status: "resolved",
      createdAt: "2026-11-03T09:00:00+05:30",
    });

    const { items, total } = await listMyComplaints(db, student, PAGE);

    expect(total).toBe(2);
    expect(items.map((i) => i.id)).toEqual([newer, older]);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(ITEM_FIELDS);
    expect(items[0]).toMatchObject({
      category: "internet",
      description: "Wi-Fi drops every evening on the second floor.",
      status: "resolved",
    });
    expect(items[0].createdAt).toEqual(new Date("2026-11-03T09:00:00+05:30"));
    expect(items[0].resolvedAt).toBeInstanceOf(Date);
    expect(items[1].resolvedAt).toBeNull();
  });

  it("orders complaints created at the same moment by id, newest first", async () => {
    const student = await insertStudent(db);
    const at = "2026-11-02T12:00:00+05:30";
    const first = await addComplaint(student, { category: "food", createdAt: at });
    const second = await addComplaint(student, { category: "internet", createdAt: at });

    const { items } = await listMyComplaints(db, student, PAGE);
    expect(items.map((i) => i.id)).toEqual([second, first]);
  });

  it("shows only the student's own complaints", async () => {
    const a = await insertStudent(db);
    const b = await insertStudent(db);
    const ofA = await addComplaint(a);
    const ofB = await addComplaint(b);

    const listA = await listMyComplaints(db, a, PAGE);
    expect(listA.items.map((i) => i.id)).toEqual([ofA]);
    expect(listA.total).toBe(1);
    expect((await listMyComplaints(db, b, PAGE)).items.map((i) => i.id)).toEqual([ofB]);
  });

  it("is empty for a student with no complaints, an owner and an unknown id", async () => {
    const someone = await insertStudent(db);
    await addComplaint(someone);
    for (const id of [await insertStudent(db), await insertOwner(db), MISSING]) {
      expect(await listMyComplaints(db, id, PAGE)).toEqual({ items: [], total: 0 });
    }
  });

  it("pages through the list, with the total on every page", async () => {
    const student = await insertStudent(db);
    const ids: number[] = [];
    for (const [category, day] of [["food", "01"], ["internet", "02"], ["security", "03"]] as const) {
      ids.push(await addComplaint(student, { category, createdAt: `2026-11-${day}T09:00:00+05:30` }));
    }
    const [oldest, middle, newest] = ids;

    const page = (n: number) => listMyComplaints(db, student, { page: n, limit: 2 });
    const one = await page(1);
    const two = await page(2);
    const three = await page(3);

    expect(one.items.map((i) => i.id)).toEqual([newest, middle]);
    expect(two.items.map((i) => i.id)).toEqual([oldest]);
    expect(three.items).toEqual([]);
    expect([one.total, two.total, three.total]).toEqual([3, 3, 3]);
  });
});

describe("getMyComplaint", () => {
  it("returns the complaint and its timeline, oldest entry first, with the owner's note", async () => {
    const student = await insertStudent(db);
    const owner = await insertOwner(db);
    const id = await addComplaint(student, { status: "in_progress", createdAt: "2026-11-04T09:00:00+05:30" });
    // Written out of order, to show the order comes from the times.
    await addEvent(id, owner, { kind: "note", note: "Plumber booked for Friday.", at: "2026-11-04T11:00:00+05:30" });
    await addEvent(id, student, { kind: "created", at: "2026-11-04T09:00:00+05:30" });
    await addEvent(id, owner, { kind: "status_change", from: "open", to: "in_progress", at: "2026-11-04T10:00:00+05:30" });

    const detail = await getMyComplaint(db, student, id);

    expect(Object.keys(detail).sort()).toEqual([...ITEM_FIELDS, "events"].sort());
    expect(detail).toMatchObject({ id, category: "plumbing", status: "in_progress", resolvedAt: null });
    expect(detail.createdAt).toEqual(new Date("2026-11-04T09:00:00+05:30"));
    expect(detail.events).toEqual([
      { kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: new Date("2026-11-04T09:00:00+05:30") },
      {
        kind: "status_change",
        note: null,
        fromStatus: "open",
        toStatus: "in_progress",
        createdAt: new Date("2026-11-04T10:00:00+05:30"),
      },
      {
        kind: "note",
        note: "Plumber booked for Friday.",
        fromStatus: null,
        toStatus: null,
        createdAt: new Date("2026-11-04T11:00:00+05:30"),
      },
    ]);
    for (const e of detail.events) expect(Object.keys(e).sort()).toEqual(EVENT_FIELDS);
  });

  it("orders timeline entries at the same moment by id", async () => {
    const student = await insertStudent(db);
    const owner = await insertOwner(db);
    const id = await addComplaint(student);
    const at = "2026-11-04T10:00:00+05:30";
    await addEvent(id, owner, { kind: "note", note: "First.", at });
    await addEvent(id, owner, { kind: "note", note: "Second.", at });

    const { events } = await getMyComplaint(db, student, id);
    expect(events.map((e) => e.note)).toEqual(["First.", "Second."]);
  });

  it("never shows the priority, even when the owner has set it", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student);
    await db.query("UPDATE complaints SET priority = 'high' WHERE id = $1", [id]);

    const detail = await getMyComplaint(db, student, id);
    expect(detail).not.toHaveProperty("priority");
    const { items } = await listMyComplaints(db, student, PAGE);
    expect(items[0]).not.toHaveProperty("priority");
  });

  it("answers another student's complaint exactly like one that does not exist", async () => {
    const raiser = await insertStudent(db);
    const other = await insertStudent(db);
    const id = await addComplaint(raiser);

    const notYours = await refusal(getMyComplaint(db, other, id));
    const missing = await refusal(getMyComplaint(db, other, MISSING));

    expect(notYours).toEqual(NOT_FOUND);
    expect(missing).toEqual(notYours);
    // The complaint is still there for the student who raised it.
    expect((await getMyComplaint(db, raiser, id)).id).toBe(id);
  });

  it("refuses an owner's id and an unknown id with the same 404", async () => {
    const id = await addComplaint(await insertStudent(db));
    expect(await refusal(getMyComplaint(db, await insertOwner(db), id))).toEqual(NOT_FOUND);
    expect(await refusal(getMyComplaint(db, MISSING, id))).toEqual(NOT_FOUND);
  });

  it("returns an empty timeline when there are no entries yet", async () => {
    const student = await insertStudent(db);
    const id = await addComplaint(student);
    expect((await getMyComplaint(db, student, id)).events).toEqual([]);
  });
});

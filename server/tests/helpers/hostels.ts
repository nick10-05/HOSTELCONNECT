import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hostelToday } from "../../src/lib/dates";
import { insertOwner, insertStructure, insertStudent } from "./db";

// Multi-tenant tests (phases 2b-2 and 2c): hostels filled with one of everything, in the
// caller's transaction (inRollback). Rows are written straight to the tables, each in the
// hostel the transaction is marked with.

const MONTH = hostelToday().slice(0, 7);

// Marks the rest of the transaction with this hostel, as withHostel would.
export const asHostel = (c: PoolClient, id: number) => c.query(`SET LOCAL app.hostel_id = '${id}'`);

export type HostelB = Awaited<ReturnType<typeof fillHostelB>>;

// A new hostel B with one of everything.
export async function fillHostelB(c: PoolClient, name = "Hostel B") {
  const hostel = (
    await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ($1) RETURNING id", [name])
  ).rows[0].id;
  await asHostel(c, hostel);
  return { hostel, ...(await fillHostel(c)) };
}

// One of everything in the transaction's hostel, written straight to the tables.
export async function fillHostel(c: PoolClient) {
  const id = async (sql: string, params: unknown[] = []) => (await c.query<{ id: number }>(sql, params)).rows[0].id;

  const owner = await insertOwner(c);
  const place = await insertStructure(c);
  const spareFloor = await id("INSERT INTO floors (building_id, number) VALUES ($1, 9) RETURNING id", [place.building]);
  const spareRoom = await id("INSERT INTO rooms (building_id, room_number) VALUES ($1, 'B-SPARE') RETURNING id", [
    place.building,
  ]);
  const emptyBuilding = await id("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [`B empty ${randomUUID()}`]);

  const student = await insertStudent(c);
  await c.query(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
     VALUES ($1, $2, $3, $4, '2026-01-14', $5)`,
    [student, place.building, place.room, place.bed1, owner],
  );
  const former = await insertStudent(c, { isActive: false });
  const formerEmail = (await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [former])).rows[0]
    .email;
  const rejoin = await id("INSERT INTO rejoin_requests (student_id, message) VALUES ($1, 'Back please') RETURNING id", [
    former,
  ]);
  // A former student with no request yet.
  const quietFormer = await insertStudent(c, { isActive: false });
  const quietFormerEmail = (await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [quietFormer]))
    .rows[0].email;

  const complaint = await id(
    `INSERT INTO complaints (student_id, category, description, priority)
     VALUES ($1, 'plumbing', 'The tap in hostel B leaks.', 'high') RETURNING id`,
    [student],
  );
  await c.query("INSERT INTO complaint_events (complaint_id, actor_id, kind) VALUES ($1, $2, 'created')", [
    complaint,
    student,
  ]);
  const announcement = await id(
    "INSERT INTO announcements (author_id, title, body) VALUES ($1, 'B notice', 'Only for hostel B.') RETURNING id",
    [owner],
  );
  const poll = await id("INSERT INTO return_polls (title, created_by) VALUES ('B poll', $1) RETURNING id", [owner]);
  await c.query("INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, 'returned')", [
    poll,
    student,
  ]);
  const fee = await id("INSERT INTO fees (student_id, due_date, amount) VALUES ($1, $2, 4000) RETURNING id", [
    student,
    `${MONTH}-01`,
  ]);
  const notification = await id(
    "INSERT INTO notifications (user_id, type, title) VALUES ($1, 'announcement', 'B only') RETURNING id",
    [student],
  );
  return {
    owner, ...place, spareFloor, spareRoom, emptyBuilding, student, former, formerEmail, quietFormer, quietFormerEmail, rejoin,
    complaint, announcement, poll, fee, notification,
  };
}

// Every row of a hostel, read with its hostel named explicitly (not through the
// services), so "nothing of this hostel's changed" does not depend on the code under test.
// Row-level security (migration 018) shows only the marked hostel's rows, so the reads
// run marked with `hostel`; the transaction's mark is put back afterwards.
export async function rowsOfHostel(c: PoolClient, hostel: number) {
  const mark = (await c.query<{ mark: string | null }>("SELECT current_setting('app.hostel_id', true) AS mark")).rows[0]
    .mark;
  await asHostel(c, hostel);
  const out: Record<string, unknown[]> = {};
  for (const table of [
    "users", "buildings", "floors", "rooms", "beds", "stays", "rejoin_requests", "notifications",
    "complaints", "complaint_events", "announcements", "return_polls", "return_poll_responses", "fees",
    "hostel_settings",
  ]) {
    out[table] = (await c.query(`SELECT * FROM ${table} WHERE hostel_id = $1 ORDER BY 1, 2`, [hostel])).rows;
  }
  await c.query("SELECT set_config('app.hostel_id', $1, true)", [mark ?? ""]);
  return out;
}

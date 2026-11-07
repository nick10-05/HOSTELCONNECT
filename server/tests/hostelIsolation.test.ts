import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { digestCounts } from "../src/jobs/digest";
import { hostelToday } from "../src/lib/dates";
import { deleteAnnouncement, listAnnouncements, updateAnnouncement } from "../src/services/announcements";
import {
  addComplaintNote,
  changeComplaintStatus,
  getMyComplaint,
  getOwnerComplaint,
  listMyComplaints,
  listOwnerComplaints,
} from "../src/services/complaints";
import { getDashboard } from "../src/services/dashboard";
import { getMyFees, listFees, markFee } from "../src/services/fees";
import { getFoodCounts } from "../src/services/food";
import { listNotifications, markAllRead, markRead, notify } from "../src/services/notifications";
import { getComplaintPhoto } from "../src/services/photos";
import { approveRejoinRequest, listRejoinRequests, rejectRejoinRequest, requestRejoin } from "../src/services/rejoin";
import { answerPoll, closePoll, getPollResults, listOpenPollsForStudent, listPolls } from "../src/services/returnPolls";
import { addBed, addFloor, addRoom, deleteBuilding, deleteFloor, deleteRoom, listStructure, reactivateBed, retireBed } from "../src/services/structure";
import {
  admitStudent,
  deactivateStudent,
  getStudent,
  listStudents,
  resetStudentPassword,
  transferStudent,
  updateStudent,
} from "../src/services/students";
import { inRollback, insertOwner, insertStructure, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// Multi-tenant phase 2b-2: every service query is scoped to the transaction's hostel
// (hostel_id = current_hostel_id()). Two hostels in one rolled-back transaction: hostel
// #1, as the existing tests use it, and a new hostel B, filled with one of everything.
// Working as hostel #1:
//   - every list, count and total reads the same before and after B's rows exist;
//   - every lookup or change by id of one of B's rows answers 404 (as for a row that does
//     not exist) and changes nothing of B's.
// Row-level security (phase 2d) will back this up in the database itself.
const db = testPool();
afterAll(() => db.end());

const TODAY = hostelToday();
const MONTH = TODAY.slice(0, 7);

const asHostel = (c: PoolClient, id: number) => c.query(`SET LOCAL app.hostel_id = '${id}'`);

type HostelB = Awaited<ReturnType<typeof fillHostelB>>;

// A new hostel B with one of everything.
async function fillHostelB(c: PoolClient) {
  const hostel = (
    await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Hostel B') RETURNING id")
  ).rows[0].id;
  await asHostel(c, hostel);
  return { hostel, ...(await fillHostel(c)) };
}

// One of everything in the transaction's hostel, written straight to the tables.
async function fillHostel(c: PoolClient) {
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
    owner, ...place, spareFloor, spareRoom, emptyBuilding, student, former, formerEmail, quietFormerEmail, rejoin,
    complaint, announcement, poll, fee, notification,
  };
}

// Everything of hostel B's, read with its hostel named explicitly (not through the
// services), so "nothing of B's changed" does not depend on the code under test.
async function rowsOfB(c: PoolClient, b: HostelB) {
  const out: Record<string, unknown[]> = {};
  for (const table of [
    "users", "buildings", "floors", "rooms", "beds", "stays", "rejoin_requests", "notifications",
    "complaints", "complaint_events", "announcements", "return_polls", "return_poll_responses", "fees",
  ]) {
    out[table] = (await c.query(`SELECT * FROM ${table} WHERE hostel_id = $1 ORDER BY 1, 2`, [b.hostel])).rows;
  }
  return out;
}

// What hostel #1's owner and lists see: every list, count and total in one object.
async function hostelOneView(tx: Db, student: number) {
  return {
    structure: await listStructure(tx),
    students: await listStudents(tx, {
      search: null, buildingId: null, floorId: null, roomId: null, category: null, active: null, page: 1, limit: 100,
    }),
    announcements: await listAnnouncements(tx, { page: 1, limit: 50 }),
    complaints: await listOwnerComplaints(tx, {
      status: null, priority: null, category: null, buildingId: null, from: null, to: null, page: 1, limit: 50,
    }),
    myComplaints: await listMyComplaints(tx, student, { page: 1, limit: 50 }),
    fees: await listFees(tx, { month: MONTH, status: null, buildingId: null, page: 1, limit: 100 }, TODAY),
    polls: await listPolls(tx, { page: 1, limit: 50 }),
    openPolls: await listOpenPollsForStudent(tx, student),
    pendingRequests: await listRejoinRequests(tx, { status: "pending", page: 1, limit: 50 }),
    decidedRequests: await listRejoinRequests(tx, { status: "decided", page: 1, limit: 50 }),
    dashboard: await getDashboard(tx, TODAY),
    food: await getFoodCounts(tx, TODAY),
    digest: await digestCounts(tx, TODAY),
  };
}

const notFound = expect.objectContaining({ status: 404 });

describe("two hostels: hostel #1 never sees or touches hostel B", () => {
  it("reads the same lists, counts and totals before and after hostel B has one of everything", () =>
    inRollback(db, async (c) => {
      const tx = rollbackDb(c);
      // Hostel #1 has one of everything too, so a count that wrongly took in hostel B's
      // rows would differ. Its poll is closed: one poll may be open at a time (migration 011).
      const one = await fillHostel(c);
      await c.query("UPDATE return_polls SET status = 'closed', closed_at = now() WHERE id = $1", [one.poll]);
      const student = one.student;
      const before = await hostelOneView(tx, student);
      await fillHostelB(c);
      await asHostel(c, 1);
      expect(await hostelOneView(tx, student)).toEqual(before);
      // REPEATABLE READ: other test files commit hostel #1 rows while this runs; the
      // snapshot keeps them out, while this transaction's own rows (hostel B's) are seen.
    }, { repeatableRead: true }));

  it("answers 404 for every one of hostel B's rows asked for by id, and changes none of them", () =>
    inRollback(db, async (c) => {
      const tx = rollbackDb(c);
      const b = await fillHostelB(c);
      await asHostel(c, 1);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const place = await insertStructure(c);
      await c.query(
        `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
         VALUES ($1, $2, $3, NULL, '2026-01-14', $4)`,
        [student, place.building, place.room, owner],
      );
      const untouched = await rowsOfB(c, b);

      const refusals: [string, () => Promise<unknown>][] = [
        ["getStudent", () => getStudent(tx, b.student, TODAY)],
        ["updateStudent", () => updateStudent(tx, b.student, {
          name: "Renamed", email: `renamed-${randomUUID()}@test.local`, phone: "9876543210", parentPhone: "9876500000",
          category: "other", collegeName: null, branch: null, academicYear: null, company: null, designation: null,
          foodPreference: "veg", vegDays: [], monthlyFee: 100,
        })],
        ["transferStudent", () => transferStudent(tx, owner, b.student, { buildingId: place.building, roomId: null, bedId: null }, TODAY)],
        ["deactivateStudent", () => deactivateStudent(tx, b.student, TODAY)],
        ["resetStudentPassword", () => resetStudentPassword(tx, b.student)],
        ["admitStudent into B's building", () => admitStudent(tx, owner, {
          name: "Asha Rao", email: `asha-${randomUUID()}@test.local`, phone: "9876543210", parentPhone: "9876500000",
          category: "college", collegeName: "City College", branch: "CSE", academicYear: 2, company: null, designation: null,
          joiningDate: TODAY, foodPreference: "veg", vegDays: [], monthlyFee: 6500,
          buildingId: b.building, roomId: null, bedId: null,
        })],
        ["transfer into B's building", () => transferStudent(tx, owner, student, { buildingId: b.building, roomId: null, bedId: null }, TODAY)],
        ["addFloor", () => addFloor(tx, b.building, 7)],
        ["addRoom", () => addRoom(tx, b.building, { roomNumber: "X1", floorId: null })],
        ["addRoom with B's floor", () => addRoom(tx, place.building, { roomNumber: "X2", floorId: b.floor })],
        ["addBed", () => addBed(tx, b.room, "Z")],
        ["retireBed", () => retireBed(tx, b.bed2)],
        ["reactivateBed", () => reactivateBed(tx, b.bed2)],
        ["deleteBuilding", () => deleteBuilding(tx, b.emptyBuilding)],
        ["deleteFloor", () => deleteFloor(tx, b.spareFloor)],
        ["deleteRoom", () => deleteRoom(tx, b.spareRoom)],
        ["updateAnnouncement", () => updateAnnouncement(tx, b.announcement, { title: "Changed" })],
        ["deleteAnnouncement", () => deleteAnnouncement(tx, b.announcement)],
        ["getOwnerComplaint", () => getOwnerComplaint(tx, b.complaint)],
        ["getMyComplaint", () => getMyComplaint(tx, b.student, b.complaint)],
        ["changeComplaintStatus", () => changeComplaintStatus(tx, owner, b.complaint, { from: "open", to: "in_progress" })],
        ["addComplaintNote", () => addComplaintNote(tx, owner, b.complaint, "A note")],
        ["markFee", () => markFee(tx, b.fee, owner, { status: "paid", paidOn: TODAY, note: null }, TODAY)],
        ["closePoll", () => closePoll(tx, b.poll)],
        ["getPollResults", () => getPollResults(tx, b.poll)],
        ["answerPoll", () => answerPoll(tx, b.poll, student, "not_yet")],
        ["rejectRejoinRequest", () => rejectRejoinRequest(tx, owner, b.rejoin)],
        ["approveRejoinRequest", () => approveRejoinRequest(tx, owner, b.rejoin, { joiningDate: TODAY, buildingId: place.building, roomId: null, bedId: null })],
        ["markRead", () => markRead(tx, b.student, b.notification)],
      ];
      for (const [name, call] of refusals) {
        await expect(call(), name).rejects.toEqual(notFound);
      }

      // Calls that answer "nothing" rather than 404 for someone else's rows.
      expect(await listNotifications(tx, b.student, { page: 1, limit: 50 })).toEqual({ items: [], total: 0, unread: 0 });
      expect(await markAllRead(tx, b.student)).toBe(0);
      expect((await getMyFees(tx, b.student, TODAY)).history).toEqual([]);
      expect(await listMyComplaints(tx, b.student, { page: 1, limit: 50 })).toMatchObject({ items: [], total: 0 });
      expect(await getComplaintPhoto(tx, b.complaint)).toEqual({ path: null, sizeBytes: null, expiresAt: null, deletedAt: null });
      // Hostel B's former student, with and without a pending request of their own.
      await requestRejoin(tx, b.formerEmail, "From hostel #1's form");
      await requestRejoin(tx, b.quietFormerEmail, "From hostel #1's form");
      expect(await notify(tx, "active_students", { type: "announcement", title: "Hostel #1 only" })).toBeGreaterThan(0);
      expect(await notify(tx, [b.student], { type: "announcement", title: "Not for B" })).toBe(0);

      expect(await rowsOfB(c, b)).toEqual(untouched);
    }));
});

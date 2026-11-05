import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getDashboard } from "../src/services/dashboard";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// getDashboard (Claude). Other test files add buildings, students and requests at the
// same time, so each test runs in a transaction that is rolled back and takes one
// snapshot of the database (REPEATABLE READ): its own rows are exact, and totals are
// compared before and after within that same snapshot.
const db = testPool();
afterAll(() => db.end());

const TODAY = "2026-11-05";

function inSnapshot(fn: (c: PoolClient) => Promise<void>) {
  return inRollback(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await fn(c);
  });
}

const one = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query<{ id: number }>(sql, params)).rows[0].id;

// A building named `name`, with `beds` beds in one room (none and no room when 0).
async function building(c: PoolClient, name: string, beds = 0) {
  const id = await one(c, "INSERT INTO buildings (name) VALUES ($1) RETURNING id", [`${name} ${Math.random()}`]);
  const bedIds: number[] = [];
  if (beds > 0) {
    const room = await one(c, "INSERT INTO rooms (building_id, room_number) VALUES ($1, '101') RETURNING id", [id]);
    for (let i = 0; i < beds; i += 1) {
      bedIds.push(await one(c, "INSERT INTO beds (room_id, bed_number) VALUES ($1, $2) RETURNING id", [room, `B${i}`]));
    }
    return { id, room, bedIds };
  }
  return { id, room: null, bedIds };
}

// A student living in `buildingId` (and `bedId`, with its room) since `startedOn`.
async function resident(
  c: PoolClient,
  place: { buildingId: number; room?: number | null; bedId?: number },
  opts: { startedOn?: string; endedOn?: string; active?: boolean } = {},
) {
  const owner = await insertOwner(c);
  const student = await insertStudent(c, { isActive: opts.active ?? true });
  await c.query(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, ended_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      student,
      place.buildingId,
      place.bedId ? place.room : null,
      place.bedId ?? null,
      opts.startedOn ?? "2026-01-14",
      opts.endedOn ?? null,
      owner,
    ],
  );
  return student;
}

const card = (d: Awaited<ReturnType<typeof getDashboard>>, id: number) =>
  d.students.buildings.find((b) => b.id === id);

describe("getDashboard: the students card", () => {
  it("counts each building's current students and its free, occupied and total beds", () =>
    inSnapshot(async (c) => {
      const a = await building(c, "Block A", 3);
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[0] });
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[1] });
      await resident(c, { buildingId: a.id }); // in the building, no bed yet

      const d = await getDashboard(c, TODAY);

      expect(card(d, a.id)).toEqual({
        id: a.id,
        name: expect.stringMatching(/^Block A /),
        students: 3,
        joiningLater: 0,
        beds: { total: 3, occupied: 2, vacant: 1 },
      });
    }));

  it("lists a building with no beds, and one with nobody in it", () =>
    inSnapshot(async (c) => {
      const noBeds = await building(c, "Annexe");
      const empty = await building(c, "New wing", 2);
      await resident(c, { buildingId: noBeds.id });

      const d = await getDashboard(c, TODAY);

      expect(card(d, noBeds.id)).toMatchObject({ students: 1, beds: null });
      expect(card(d, empty.id)).toMatchObject({ students: 0, joiningLater: 0, beds: { total: 2, occupied: 0, vacant: 2 } });
    }));

  it("leaves out retired beds and former students", () =>
    inSnapshot(async (c) => {
      const a = await building(c, "Block B", 3);
      await c.query("UPDATE beds SET is_active = false WHERE id = $1", [a.bedIds[2]]);
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[0] });
      // Moved out: the stay ended, the account is inactive.
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[1] }, { endedOn: "2026-06-30", active: false });

      const d = await getDashboard(c, TODAY);

      expect(card(d, a.id)).toMatchObject({ students: 1, beds: { total: 2, occupied: 1, vacant: 1 } });
    }));

  it("counts a student who has not arrived yet, and holds their bed (decided on day 5)", () =>
    inSnapshot(async (c) => {
      const a = await building(c, "Block C", 2);
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[0] });
      await resident(c, { buildingId: a.id, room: a.room, bedId: a.bedIds[1] }, { startedOn: "2026-11-20" });
      // Arriving today has arrived.
      await resident(c, { buildingId: a.id }, { startedOn: TODAY });

      const d = await getDashboard(c, TODAY);

      expect(card(d, a.id)).toMatchObject({ students: 3, joiningLater: 1, beds: { total: 2, occupied: 2, vacant: 0 } });
    }));

  it("adds the buildings up in the totals, and lists buildings by name", () =>
    inSnapshot(async (c) => {
      const before = await getDashboard(c, TODAY);
      const z = await building(c, "zz last");
      const a = await building(c, "aa first");
      await resident(c, { buildingId: z.id });
      await resident(c, { buildingId: a.id }, { startedOn: "2026-12-01" });

      const after = await getDashboard(c, TODAY);

      expect(after.students.total).toBe(before.students.total + 2);
      expect(after.students.joiningLater).toBe(before.students.joiningLater + 1);
      expect(after.students.total).toBe(after.students.buildings.reduce((sum, b) => sum + b.students, 0));
      // By name, as on the structure page; checked on this test's own two buildings only,
      // since other files' names (and the database's sorting rules) vary.
      const ids = after.students.buildings.map((b) => b.id);
      expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(z.id));
    }));
});

describe("getDashboard: the rejoin requests card", () => {
  it("counts pending requests only, and gives the oldest one's date in India", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const before = await getDashboard(c, TODAY);
      const request = async (createdAt: string, status = "pending") => {
        const student = await insertStudent(c, { isActive: false });
        await c.query(
          `INSERT INTO rejoin_requests (student_id, created_at, status, decided_at, decided_by)
           VALUES ($1, $2, $3, CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
                   CASE WHEN $3 = 'pending' THEN NULL ELSE $4::bigint END)`,
          [student, createdAt, status, owner],
        );
      };
      // 23:30 UTC on 31 Dec 1999 is already 1 January 2000 in India.
      await request("1999-12-31T23:30:00Z");
      await request("2026-11-04T10:00:00+05:30");
      await request("1990-01-01T10:00:00+05:30", "rejected");

      const after = await getDashboard(c, TODAY);

      expect(after.rejoinRequests.pending).toBe(before.rejoinRequests.pending + 2);
      expect(after.rejoinRequests.oldestRequestedOn).toBe("2000-01-01");
    }));
});

describe("getDashboard: the complaints card", () => {
  const complain = async (
    c: PoolClient,
    student: number,
    category: string,
    opts: { status?: string; priority?: string; createdAt?: string } = {},
  ) => {
    await c.query(
      `INSERT INTO complaints (student_id, category, description, status, priority, resolved_at, created_at)
       VALUES ($1, $2, 'The tap in room 101 keeps dripping.', $3, $4,
               CASE WHEN $3 = 'resolved' THEN now() END, coalesce($5::timestamptz, now()))`,
      [student, category, opts.status ?? "open", opts.priority ?? "normal", opts.createdAt ?? null],
    );
  };

  it("counts active complaints and the high-priority ones among them, not resolved or rejected", () =>
    inSnapshot(async (c) => {
      const before = await getDashboard(c, TODAY);
      const a = await insertStudent(c);
      const b = await insertStudent(c, { isActive: false }); // moved out: still counted
      await complain(c, a, "plumbing");
      await complain(c, a, "electrical", { status: "in_progress", priority: "high" });
      await complain(c, b, "food", { priority: "high" });
      await complain(c, a, "internet", { status: "resolved", priority: "high" });
      await complain(c, b, "security", { status: "rejected" });

      const after = await getDashboard(c, TODAY);

      expect(after.complaints.active).toBe(before.complaints.active + 3);
      expect(after.complaints.highPriority).toBe(before.complaints.highPriority + 2);
    }));

  it("gives when the oldest active complaint was raised, ignoring closed ones", () =>
    inSnapshot(async (c) => {
      const a = await insertStudent(c);
      // Older than anything another test file writes.
      await complain(c, a, "furniture", { status: "resolved", createdAt: "1989-01-01T00:00:00Z" });
      await complain(c, a, "plumbing", { createdAt: "1990-03-01T04:30:00Z" });
      await complain(c, a, "food", { createdAt: "2026-11-01T04:30:00Z" });

      const d = await getDashboard(c, TODAY);

      expect(d.complaints.oldestActiveAt).toEqual(new Date("1990-03-01T04:30:00Z"));
    }));
});

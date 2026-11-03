import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, pgError, testPool } from "./helpers/db";

// These tests prove the rules the database itself enforces for buildings, rooms, beds
// and stays, so they hold even if a service function has a bug.
const db = testPool();
afterAll(() => db.end());

const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

async function one(c: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ id: number }>(sql, params);
  return rows[0].id;
}

// A building with one floor, one room on that floor and two beds in the room.
async function structure(c: PoolClient) {
  const building = await one(c, "INSERT INTO buildings (name) VALUES ($1) RETURNING id", [
    `Building ${randomUUID()}`,
  ]);
  const floor = await one(
    c,
    "INSERT INTO floors (building_id, number) VALUES ($1, 1) RETURNING id",
    [building],
  );
  const room = await one(
    c,
    "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, '101') RETURNING id",
    [building, floor],
  );
  const bed1 = await one(c, "INSERT INTO beds (room_id, bed_number) VALUES ($1, 'A') RETURNING id", [
    room,
  ]);
  const bed2 = await one(c, "INSERT INTO beds (room_id, bed_number) VALUES ($1, 'B') RETURNING id", [
    room,
  ]);
  return { building, floor, room, bed1, bed2 };
}

type StayFields = {
  student: number;
  owner: number;
  building: number;
  room?: number | null;
  bed?: number | null;
  startedOn?: string;
  endedOn?: string | null;
};

const INSERT_STAY = `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, ended_on, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

function stayParams(s: StayFields): unknown[] {
  return [
    s.student,
    s.building,
    s.room ?? null,
    s.bed ?? null,
    s.startedOn ?? "2026-01-14",
    s.endedOn ?? null,
    s.owner,
  ];
}

const addStay = (c: PoolClient, s: StayFields) => one(c, INSERT_STAY, stayParams(s));
const failStay = (c: PoolClient, s: StayFields) => pgError(c, INSERT_STAY, stayParams(s));

describe("buildings, floors and rooms", () => {
  it("treats building names as case-insensitive", () =>
    inRollback(db, async (c) => {
      const name = `Block ${randomUUID()}`;
      await c.query("INSERT INTO buildings (name) VALUES ($1)", [name]);
      const err = await pgError(c, "INSERT INTO buildings (name) VALUES ($1)", [name.toUpperCase()]);
      expect(err.code).toBe(UNIQUE_VIOLATION);
    }));

  it("allows a room without a floor", () =>
    inRollback(db, async (c) => {
      const { building } = await structure(c);
      await c.query("INSERT INTO rooms (building_id, room_number) VALUES ($1, 'G1')", [building]);
    }));

  it("refuses a room on a floor of another building", () =>
    inRollback(db, async (c) => {
      const a = await structure(c);
      const b = await structure(c);
      const err = await pgError(
        c,
        "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, '201')",
        [b.building, a.floor],
      );
      expect(err.code).toBe(FOREIGN_KEY_VIOLATION);
    }));

  it("refuses a duplicate room number in the same building", () =>
    inRollback(db, async (c) => {
      const { building } = await structure(c);
      const err = await pgError(
        c,
        "INSERT INTO rooms (building_id, room_number) VALUES ($1, '101')",
        [building],
      );
      expect(err.code).toBe(UNIQUE_VIOLATION);
    }));
});

describe("stays", () => {
  it("allows a stay with only a building", () =>
    inRollback(db, async (c) => {
      const { building } = await structure(c);
      await addStay(c, { student: await insertStudent(c), owner: await insertOwner(c), building });
    }));

  it("refuses a bed without a room", () =>
    inRollback(db, async (c) => {
      const { building, bed1 } = await structure(c);
      const err = await failStay(c, {
        student: await insertStudent(c),
        owner: await insertOwner(c),
        building,
        bed: bed1,
      });
      expect(err.constraint).toBe("stays_bed_needs_room");
    }));

  it("refuses a room from another building and a bed from another room", () =>
    inRollback(db, async (c) => {
      const a = await structure(c);
      const b = await structure(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const wrongRoom = await failStay(c, { student, owner, building: a.building, room: b.room });
      expect(wrongRoom.code).toBe(FOREIGN_KEY_VIOLATION);
      const wrongBed = await failStay(c, {
        student,
        owner,
        building: a.building,
        room: a.room,
        bed: b.bed1,
      });
      expect(wrongBed.code).toBe(FOREIGN_KEY_VIOLATION);
    }));

  it("refuses an end date before the start date", () =>
    inRollback(db, async (c) => {
      const { building } = await structure(c);
      const err = await failStay(c, {
        student: await insertStudent(c),
        owner: await insertOwner(c),
        building,
        startedOn: "2026-03-01",
        endedOn: "2026-02-28",
      });
      expect(err.constraint).toBe("stays_dates_in_order");
    }));

  it("allows only one current stay per student", () =>
    inRollback(db, async (c) => {
      const a = await structure(c);
      const b = await structure(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      await addStay(c, { student, owner, building: a.building });
      const err = await failStay(c, { student, owner, building: b.building });
      expect(err.constraint).toBe("stays_one_current_per_student");
    }));

  it("allows only one current student per bed, and frees the bed when the stay ends", () =>
    inRollback(db, async (c) => {
      const { building, room, bed1 } = await structure(c);
      const owner = await insertOwner(c);
      const first = await insertStudent(c);
      const second = await insertStudent(c);
      const stay = await addStay(c, { student: first, owner, building, room, bed: bed1 });

      const err = await failStay(c, { student: second, owner, building, room, bed: bed1 });
      expect(err.constraint).toBe("stays_one_current_per_bed");

      await c.query("UPDATE stays SET ended_on = '2026-02-01' WHERE id = $1", [stay]);
      await addStay(c, { student: second, owner, building, room, bed: bed1, startedOn: "2026-02-01" });
    }));

  it("keeps history across a same-day transfer", () =>
    inRollback(db, async (c) => {
      const { building, room, bed1, bed2 } = await structure(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const old = await addStay(c, { student, owner, building, room, bed: bed1 });

      await c.query("UPDATE stays SET ended_on = '2026-03-10' WHERE id = $1", [old]);
      await addStay(c, { student, owner, building, room, bed: bed2, startedOn: "2026-03-10" });

      const { rows } = await c.query(
        "SELECT bed_id, ended_on FROM stays WHERE student_id = $1 ORDER BY id",
        [student],
      );
      expect(rows).toHaveLength(2);
      expect(rows[1].ended_on).toBeNull();
    }));

  it("requires a creator", () =>
    inRollback(db, async (c) => {
      const { building } = await structure(c);
      const err = await pgError(
        c,
        "INSERT INTO stays (student_id, building_id, started_on) VALUES ($1, $2, '2026-01-14')",
        [await insertStudent(c), building],
      );
      expect(err.code).toBe(NOT_NULL_VIOLATION);
    }));
});

describe("what the app role may change", () => {
  it("cannot delete or rewrite stays, only end them", () =>
    inRollback(db, async (c) => {
      const a = await structure(c);
      const b = await structure(c);
      const stay = await addStay(c, {
        student: await insertStudent(c),
        owner: await insertOwner(c),
        building: a.building,
      });
      const del = await pgError(c, "DELETE FROM stays WHERE id = $1", [stay]);
      expect(del.code).toBe(INSUFFICIENT_PRIVILEGE);
      const move = await pgError(c, "UPDATE stays SET building_id = $1 WHERE id = $2", [
        b.building,
        stay,
      ]);
      expect(move.code).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query("UPDATE stays SET ended_on = '2026-02-01' WHERE id = $1", [stay]);
    }));

  it("cannot delete a bed, but can retire it", () =>
    inRollback(db, async (c) => {
      const { bed1 } = await structure(c);
      const err = await pgError(c, "DELETE FROM beds WHERE id = $1", [bed1]);
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
      await c.query("UPDATE beds SET is_active = false WHERE id = $1", [bed1]);
    }));

  it("can delete an unused building together with its floors, rooms and beds", () =>
    inRollback(db, async (c) => {
      const { building, room } = await structure(c);
      await c.query("DELETE FROM buildings WHERE id = $1", [building]);
      const { rows } = await c.query("SELECT count(*)::int AS n FROM beds WHERE room_id = $1", [room]);
      expect(rows[0].n).toBe(0);
    }));

  it("cannot delete a building or room that a stay ever referenced", () =>
    inRollback(db, async (c) => {
      const { building, room, bed1 } = await structure(c);
      await addStay(c, {
        student: await insertStudent(c),
        owner: await insertOwner(c),
        building,
        room,
        bed: bed1,
        endedOn: "2026-02-01",
      });
      const roomErr = await pgError(c, "DELETE FROM rooms WHERE id = $1", [room]);
      expect(roomErr.code).toBe(FOREIGN_KEY_VIOLATION);
      const buildingErr = await pgError(c, "DELETE FROM buildings WHERE id = $1", [building]);
      expect(buildingErr.code).toBe(FOREIGN_KEY_VIOLATION);
    }));

  it("cannot delete a floor that still has rooms", () =>
    inRollback(db, async (c) => {
      const { floor } = await structure(c);
      const err = await pgError(c, "DELETE FROM floors WHERE id = $1", [floor]);
      expect(err.code).toBe(FOREIGN_KEY_VIOLATION);
    }));
});

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { addDays, hostelToday } from "../src/lib/dates";
import { getStudent } from "../src/services/students";
import { inRollback, insertOwner, insertStay, insertStructure, insertStudent, pgError, testPool } from "./helpers/db";

// Migration 024: buildings and rooms that students lived in may be deleted, and the stays
// keep the names of where they were. These tests talk to the tables as hostel_app, as the
// app does, so they also prove what the app may and may not write.
const db = testPool();
afterAll(() => db.end());

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

type StayRow = {
  building_id: number | null;
  room_id: number | null;
  bed_id: number | null;
  building_name: string;
  floor_number: number | null;
  room_number: string | null;
  bed_number: string | null;
};
const stayRow = async (c: PoolClient, id: number) =>
  (
    await c.query<StayRow>(
      `SELECT building_id, room_id, bed_id, building_name, floor_number, room_number, bed_number
       FROM stays WHERE id = $1`,
      [id],
    )
  ).rows[0];

// A stay that starts in a week (a future joining date), in the given place.
async function futureStay(c: PoolClient, at: { building: number; room?: number; bed?: number }) {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [await insertStudent(c), at.building, at.room ?? null, at.bed ?? null, addDays(hostelToday(), 7), await insertOwner(c)],
  );
  return rows[0].id;
}

describe("copied place names", () => {
  it("are filled in by the database when a stay is written, whatever the app sends", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by,
                            building_name, room_number, bed_number, floor_number)
         VALUES ($1, $2, $3, $4, '2026-01-14', $5, 'Fake', 'Fake', 'Fake', 42) RETURNING id`,
        [await insertStudent(c), p.building, p.room, p.bed1, await insertOwner(c)],
      );
      expect(await stayRow(c, rows[0].id)).toMatchObject({
        building_name: p.buildingName,
        floor_number: 1,
        room_number: "101",
        bed_number: "A",
      });
    }));

  it("follow a future stay that is moved, and clear when it is moved to no room", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const stay = await futureStay(c, { building: p.building, room: p.room, bed: p.bed1 });
      await c.query("UPDATE stays SET bed_id = $1 WHERE id = $2", [p.bed2, stay]);
      expect((await stayRow(c, stay)).bed_number).toBe("B");
      await c.query("UPDATE stays SET room_id = NULL, bed_id = NULL WHERE id = $1", [stay]);
      expect(await stayRow(c, stay)).toMatchObject({ room_number: null, floor_number: null, bed_number: null });
    }));

  it("cannot be changed by the app", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const stay = await insertStay(c, { building: p.building, endedOn: "2026-02-01" });
      const err = await pgError(c, "UPDATE stays SET building_name = 'Other' WHERE id = $1", [stay]);
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    }));
});

describe("deleting a place students lived in", () => {
  it("deletes a building and keeps its past stays with their names", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const stay = await insertStay(c, { building: p.building, room: p.room, bed: p.bed1, endedOn: "2026-02-01" });
      await c.query("DELETE FROM buildings WHERE id = $1", [p.building]);
      expect(await stayRow(c, stay)).toEqual({
        building_id: null,
        room_id: null,
        bed_id: null,
        building_name: p.buildingName,
        floor_number: 1,
        room_number: "101",
        bed_number: "A",
      });
    }));

  it("deletes a room and keeps the stay's building and names", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const stay = await insertStay(c, { building: p.building, room: p.room, bed: p.bed2, endedOn: "2026-02-01" });
      await c.query("DELETE FROM rooms WHERE id = $1", [p.room]);
      expect(await stayRow(c, stay)).toEqual({
        building_id: p.building,
        room_id: null,
        bed_id: null,
        building_name: p.buildingName,
        floor_number: 1,
        room_number: "101",
        bed_number: "B",
      });
    }));

  it("refuses to delete a building while a stay in it is current", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      await insertStay(c, { building: p.building });
      const err = await pgError(c, "DELETE FROM buildings WHERE id = $1", [p.building]);
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "stays_current_keeps_place" });
    }));

  it("refuses to delete a room while a future stay is booked in it", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      await futureStay(c, { building: p.building, room: p.room, bed: p.bed1 });
      const err = await pgError(c, "DELETE FROM rooms WHERE id = $1", [p.room]);
      // Whichever of the stay's checks Postgres meets first while clearing its room and bed.
      expect(err.code).toBe(CHECK_VIOLATION);
      expect(["stays_current_keeps_place", "stays_bed_needs_room"]).toContain(err.constraint);
    }));

  it("still does not let the app empty a past stay's place while the place exists", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const stay = await insertStay(c, { building: p.building, room: p.room, endedOn: "2026-02-01" });
      const err = await pgError(c, "UPDATE stays SET room_id = NULL WHERE id = $1", [stay]);
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "stays_place_fixed_once_started" });
    }));
});

describe("deletion_codes", () => {
  async function code(c: PoolClient, minutes = 5) {
    const owner = await insertOwner(c);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, expires_at)
       VALUES (gen_random_uuid(), $1, 'building', 1, 'Block A', decode(repeat('ab', 32), 'hex'),
               now() + make_interval(mins => $2)) RETURNING id`,
      [owner, minutes],
    );
    return rows[0].id;
  }

  it("refuses a code that would live longer than 5 minutes", () =>
    inRollback(db, async (c) => {
      await code(c, 5);
      const err = await pgError(
        c,
        `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, expires_at)
         VALUES (gen_random_uuid(), $1, 'room', 1, 'Room 1', decode(repeat('ab', 32), 'hex'), now() + interval '6 minutes')`,
        [await insertOwner(c)],
      );
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "deletion_codes_lifetime" });
    }));

  it("lets the app change only the tries and the used / replaced / not-sent marks", () =>
    inRollback(db, async (c) => {
      const id = await code(c);
      await c.query("UPDATE deletion_codes SET attempts = 1 WHERE id = $1", [id]);
      for (const column of ["code_hash = decode(repeat('cd', 32), 'hex')", "expires_at = now()", "target_id = 2"]) {
        const err = await pgError(c, `UPDATE deletion_codes SET ${column} WHERE id = $1`, [id]);
        expect(err.code, column).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  it("only moves forward: tries never go down, a used code is never usable again", () =>
    inRollback(db, async (c) => {
      const id = await code(c);
      await c.query("UPDATE deletion_codes SET attempts = 2, consumed_at = now() WHERE id = $1", [id]);
      for (const change of ["attempts = 1", "consumed_at = NULL"]) {
        const err = await pgError(c, `UPDATE deletion_codes SET ${change} WHERE id = $1`, [id]);
        expect(err, change).toMatchObject({ code: CHECK_VIOLATION, constraint: "deletion_codes_one_way" });
      }
    }));

  it("allows at most 5 tries", () =>
    inRollback(db, async (c) => {
      const id = await code(c);
      const err = await pgError(c, "UPDATE deletion_codes SET attempts = 6 WHERE id = $1", [id]);
      expect(err.code).toBe(CHECK_VIOLATION);
    }));
});

describe("structure_deletions", () => {
  it("can be added to and read by the app, never changed or removed", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO structure_deletions (kind, name, deleted_by, floors, rooms, beds, past_stays, code_id, verified_at)
         VALUES ('building', 'Block A', $1, 1, 2, 3, 4, gen_random_uuid(), now()) RETURNING id`,
        [owner],
      );
      for (const sql of ["UPDATE structure_deletions SET name = 'B' WHERE id = $1", "DELETE FROM structure_deletions WHERE id = $1"]) {
        const err = await pgError(c, sql, [rows[0].id]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

describe("a student's stay history after a deletion", () => {
  it("shows the deleted room by its kept names and marks it removed", () =>
    inRollback(db, async (c) => {
      const p = await insertStructure(c);
      const past = await insertStay(c, { building: p.building, room: p.room, bed: p.bed1, endedOn: "2026-02-01" });
      const student = (await c.query<{ student_id: number }>("SELECT student_id FROM stays WHERE id = $1", [past])).rows[0]
        .student_id;
      const before = await getStudent(c, student, hostelToday());
      expect(before.stays[0]).toMatchObject({ roomNumber: "101", bedNumber: "A", removed: false });

      await c.query("DELETE FROM rooms WHERE id = $1", [p.room]);
      const after = await getStudent(c, student, hostelToday());
      expect(after.stays[0]).toMatchObject({
        buildingId: p.building,
        buildingName: p.buildingName,
        floorNumber: 1,
        roomId: null,
        roomNumber: "101",
        bedId: null,
        bedNumber: "A",
        removed: true,
      });

      await c.query("DELETE FROM buildings WHERE id = $1", [p.building]);
      const gone = await getStudent(c, student, hostelToday());
      expect(gone.stays[0]).toMatchObject({ buildingId: null, buildingName: p.buildingName, roomNumber: "101", removed: true });
      expect(gone.currentStay).toBeNull();
    }));
});

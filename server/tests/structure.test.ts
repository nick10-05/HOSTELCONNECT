import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import * as structure from "../src/services/structure";
import { inRollback, insertStay, insertStructure, testPool } from "./helpers/db";

// The structure rules in src/services/structure.ts (you write those). Each test runs
// in a transaction that is rolled back, so nothing is left in the test database.
const db = testPool();
afterAll(() => db.end());

// An id no row has.
const MISSING = 999_999_999;

// Runs a call that must be refused and returns what it threw. The savepoint keeps the
// test's transaction usable even if the refusal came from a failed SQL statement.
async function refusal(c: PoolClient, call: () => Promise<unknown>): Promise<unknown> {
  await c.query("SAVEPOINT refusal");
  try {
    await call();
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT refusal");
    return err;
  }
  await c.query("RELEASE SAVEPOINT refusal");
  throw new Error("expected the call to be refused, but it succeeded");
}

async function expectRefused(
  c: PoolClient,
  call: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const err = await refusal(c, call);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

const count = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n;

describe("createBuilding", () => {
  it("creates a building with a trimmed name", () =>
    inRollback(db, async (c) => {
      const name = `Block ${randomUUID()}`;
      const building = await structure.createBuilding(c, `  ${name}  `);
      expect(building).toEqual({ id: expect.any(Number), name });
    }));

  it("refuses a name already taken, ignoring case", () =>
    inRollback(db, async (c) => {
      const { buildingName } = await insertStructure(c);
      await expectRefused(
        c,
        () => structure.createBuilding(c, buildingName.toUpperCase()),
        409,
        "building_exists",
      );
    }));
});

describe("addFloor", () => {
  it("adds a floor, including the ground floor (0)", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      const floor = await structure.addFloor(c, building, 0);
      expect(floor).toEqual({ id: expect.any(Number), buildingId: building, number: 0 });
    }));

  it("refuses a floor number the building already has", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      await expectRefused(c, () => structure.addFloor(c, building, 1), 409, "floor_exists");
    }));

  it("refuses an unknown building", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.addFloor(c, MISSING, 1), 404, "building_not_found");
    }));
});

describe("addRoom", () => {
  it("adds a room on a floor", () =>
    inRollback(db, async (c) => {
      const { building, floor } = await insertStructure(c);
      const room = await structure.addRoom(c, building, { roomNumber: " 102 ", floorId: floor });
      expect(room).toEqual({
        id: expect.any(Number),
        buildingId: building,
        floorId: floor,
        roomNumber: "102",
      });
    }));

  it("adds a room straight under the building, without a floor", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      const room = await structure.addRoom(c, building, { roomNumber: "G1", floorId: null });
      expect(room.floorId).toBeNull();
    }));

  it("refuses a room number the building already has, on any floor", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      await expectRefused(
        c,
        () => structure.addRoom(c, building, { roomNumber: "101", floorId: null }),
        409,
        "room_exists",
      );
    }));

  it("refuses a floor of another building", () =>
    inRollback(db, async (c) => {
      const a = await insertStructure(c);
      const b = await insertStructure(c);
      await expectRefused(
        c,
        () => structure.addRoom(c, b.building, { roomNumber: "201", floorId: a.floor }),
        404,
        "floor_not_found",
      );
    }));

  it("refuses an unknown building", () =>
    inRollback(db, async (c) => {
      await expectRefused(
        c,
        () => structure.addRoom(c, MISSING, { roomNumber: "1", floorId: null }),
        404,
        "building_not_found",
      );
    }));
});

describe("addBed", () => {
  it("adds an active bed", () =>
    inRollback(db, async (c) => {
      const { room } = await insertStructure(c);
      const bed = await structure.addBed(c, room, " C ");
      expect(bed).toEqual({ id: expect.any(Number), roomId: room, bedNumber: "C", isActive: true });
    }));

  it("refuses a bed number the room already has", () =>
    inRollback(db, async (c) => {
      const { room } = await insertStructure(c);
      await expectRefused(c, () => structure.addBed(c, room, "A"), 409, "bed_exists");
    }));

  it("refuses an unknown room", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.addBed(c, MISSING, "A"), 404, "room_not_found");
    }));
});

describe("retireBed and reactivateBed", () => {
  it("retires a free bed and brings it back", () =>
    inRollback(db, async (c) => {
      const { bed1 } = await insertStructure(c);
      expect((await structure.retireBed(c, bed1)).isActive).toBe(false);
      // Retiring twice is not an error.
      expect((await structure.retireBed(c, bed1)).isActive).toBe(false);
      expect((await structure.reactivateBed(c, bed1)).isActive).toBe(true);
    }));

  it("refuses to retire a bed someone currently sleeps in", () =>
    inRollback(db, async (c) => {
      const { building, room, bed1 } = await insertStructure(c);
      await insertStay(c, { building, room, bed: bed1 });
      await expectRefused(c, () => structure.retireBed(c, bed1), 409, "bed_occupied");
    }));

  it("retires a bed whose stays have all ended", () =>
    inRollback(db, async (c) => {
      const { building, room, bed1 } = await insertStructure(c);
      await insertStay(c, { building, room, bed: bed1, endedOn: "2026-02-01" });
      expect((await structure.retireBed(c, bed1)).isActive).toBe(false);
    }));

  it("refuses an unknown bed", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.retireBed(c, MISSING), 404, "bed_not_found");
      await expectRefused(c, () => structure.reactivateBed(c, MISSING), 404, "bed_not_found");
    }));
});

describe("deleteBuilding", () => {
  it("deletes an unused building with its floors, rooms and beds", () =>
    inRollback(db, async (c) => {
      const { building, room } = await insertStructure(c);
      await structure.deleteBuilding(c, building);
      expect(await count(c, "buildings WHERE id = $1", [building])).toBe(0);
      expect(await count(c, "beds WHERE room_id = $1", [room])).toBe(0);
    }));

  it("refuses while any stay, even an ended one, refers to it", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      await insertStay(c, { building, endedOn: "2026-02-01" });
      await expectRefused(c, () => structure.deleteBuilding(c, building), 409, "building_in_use");
      expect(await count(c, "buildings WHERE id = $1", [building])).toBe(1);
    }));

  it("refuses an unknown building", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.deleteBuilding(c, MISSING), 404, "building_not_found");
    }));
});

describe("deleteFloor", () => {
  it("deletes an empty floor", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      const floor = await c.query<{ id: number }>(
        "INSERT INTO floors (building_id, number) VALUES ($1, 2) RETURNING id",
        [building],
      );
      await structure.deleteFloor(c, floor.rows[0].id);
      expect(await count(c, "floors WHERE id = $1", [floor.rows[0].id])).toBe(0);
    }));

  it("refuses a floor that still has rooms", () =>
    inRollback(db, async (c) => {
      const { floor } = await insertStructure(c);
      await expectRefused(c, () => structure.deleteFloor(c, floor), 409, "floor_has_rooms");
    }));

  it("refuses an unknown floor", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.deleteFloor(c, MISSING), 404, "floor_not_found");
    }));
});

describe("deleteRoom", () => {
  it("deletes an unused room with its beds", () =>
    inRollback(db, async (c) => {
      const { room } = await insertStructure(c);
      await structure.deleteRoom(c, room);
      expect(await count(c, "rooms WHERE id = $1", [room])).toBe(0);
      expect(await count(c, "beds WHERE room_id = $1", [room])).toBe(0);
    }));

  it("refuses while any stay, even an ended one, refers to it", () =>
    inRollback(db, async (c) => {
      const { building, room } = await insertStructure(c);
      await insertStay(c, { building, room, endedOn: "2026-02-01" });
      await expectRefused(c, () => structure.deleteRoom(c, room), 409, "room_in_use");
    }));

  it("refuses an unknown room", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => structure.deleteRoom(c, MISSING), 404, "room_not_found");
    }));
});

describe("listStructure", () => {
  it("returns the tree in order, with floorless rooms and bed occupancy", () =>
    inRollback(db, async (c) => {
      const { building, buildingName, floor, room, bed1, bed2 } = await insertStructure(c);
      const ground = await c.query<{ id: number }>(
        "INSERT INTO floors (building_id, number) VALUES ($1, 0) RETURNING id",
        [building],
      );
      const annex = await c.query<{ id: number }>(
        "INSERT INTO rooms (building_id, room_number) VALUES ($1, 'Annex') RETURNING id",
        [building],
      );
      await c.query("UPDATE beds SET is_active = false WHERE id = $1", [bed2]);
      await insertStay(c, { building, room, bed: bed1 });

      const tree = await structure.listStructure(c);
      const ours = tree.find((b) => b.id === building);
      expect(ours).toEqual({
        id: building,
        name: buildingName,
        floors: [
          { id: ground.rows[0].id, buildingId: building, number: 0, rooms: [] },
          {
            id: floor,
            buildingId: building,
            number: 1,
            rooms: [
              {
                id: room,
                buildingId: building,
                floorId: floor,
                roomNumber: "101",
                beds: [
                  { id: bed1, roomId: room, bedNumber: "A", isActive: true, occupied: true },
                  { id: bed2, roomId: room, bedNumber: "B", isActive: false, occupied: false },
                ],
              },
            ],
          },
        ],
        rooms: [
          { id: annex.rows[0].id, buildingId: building, floorId: null, roomNumber: "Annex", beds: [] },
        ],
      });
    }));

  it("orders room numbers the way people count (9 before 10)", () =>
    inRollback(db, async (c) => {
      const { building } = await insertStructure(c);
      await c.query("INSERT INTO rooms (building_id, room_number) VALUES ($1, '10'), ($1, '9')", [
        building,
      ]);
      const ours = (await structure.listStructure(c)).find((b) => b.id === building)!;
      expect(ours.rooms.map((r) => r.roomNumber)).toEqual(["9", "10"]);
    }));

  it("orders buildings by name", () =>
    inRollback(db, async (c) => {
      const tag = randomUUID();
      await c.query("INSERT INTO buildings (name) VALUES ($1), ($2)", [`B ${tag}`, `A ${tag}`]);
      const names = (await structure.listStructure(c))
        .map((b) => b.name)
        .filter((n) => n.endsWith(tag));
      expect(names).toEqual([`A ${tag}`, `B ${tag}`]);
    }));
});

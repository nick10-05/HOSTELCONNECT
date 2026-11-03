import type { Queryable } from "../db";
import { HttpError } from "../lib/http";

// Hostel structure: buildings, floors, rooms and beds (design doc, section 3).
// tests/structure.test.ts describes what each function must do.
//
// How refusals work:
// - Every refusal is `throw new HttpError(status, code, message)`; errorHandler sends
//   it to the client, and the owner's screen shows the message as is.
// - Existence and "in use" are checked with a query first, which reads plainly.
// - Duplicates are not checked first: the insert runs and a unique-index violation is
//   turned into a 409. That stays correct when two requests race, where a check
//   followed by an insert would let both through and one would end in a 500.
// - Inputs arrive already validated by the route (types, lengths); names are trimmed here.

export type Building = { id: number; name: string };
export type Floor = { id: number; buildingId: number; number: number };
export type Room = { id: number; buildingId: number; floorId: number | null; roomNumber: string };
export type Bed = { id: number; roomId: number; bedNumber: string; isActive: boolean };

// The whole tree, for the owner's structure screen.
export type StructureBed = Bed & { occupied: boolean };
export type StructureRoom = Room & { beds: StructureBed[] };
export type StructureFloor = Floor & { rooms: StructureRoom[] };
export type StructureBuilding = Building & {
  floors: StructureFloor[]; // ordered by number
  rooms: StructureRoom[]; // rooms that sit straight under the building (no floor)
};

// Column lists that rename snake_case columns to the camelCase fields above.
const BUILDING = "id, name";
const FLOOR = `id, building_id AS "buildingId", number`;
const ROOM = `id, building_id AS "buildingId", floor_id AS "floorId", room_number AS "roomNumber"`;
const BED = `id, room_id AS "roomId", bed_number AS "bedNumber", is_active AS "isActive"`;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const pgCode = (err: unknown) => (err as { code?: string }).code;

// Runs a write; if Postgres refuses it with the given error code, throws `refusal`
// instead. Other errors are real failures and pass through as a 500.
async function writeOr<T>(
  db: Queryable,
  sql: string,
  params: unknown[],
  code: string,
  refusal: HttpError,
): Promise<T[]> {
  try {
    return (await db.query(sql, params)).rows as T[];
  } catch (err) {
    if (pgCode(err) === code) throw refusal;
    throw err;
  }
}

async function exists(db: Queryable, sql: string, params: unknown[]): Promise<boolean> {
  return (await db.query(`SELECT EXISTS (${sql}) AS found`, params)).rows[0].found as boolean;
}

async function requireBuilding(db: Queryable, buildingId: number): Promise<void> {
  if (!(await exists(db, "SELECT 1 FROM buildings WHERE id = $1", [buildingId]))) {
    throw new HttpError(404, "building_not_found", "That building no longer exists.");
  }
}

export async function createBuilding(db: Queryable, name: string): Promise<Building> {
  const trimmed = name.trim();
  const [building] = await writeOr<Building>(
    db,
    `INSERT INTO buildings (name) VALUES ($1) RETURNING ${BUILDING}`,
    [trimmed],
    UNIQUE_VIOLATION,
    new HttpError(409, "building_exists", `There is already a building called ${trimmed}.`),
  );
  return building;
}

export async function addFloor(db: Queryable, buildingId: number, number: number): Promise<Floor> {
  await requireBuilding(db, buildingId);
  const [floor] = await writeOr<Floor>(
    db,
    `INSERT INTO floors (building_id, number) VALUES ($1, $2) RETURNING ${FLOOR}`,
    [buildingId, number],
    UNIQUE_VIOLATION,
    new HttpError(409, "floor_exists", "This building already has that floor."),
  );
  return floor;
}

export async function addRoom(
  db: Queryable,
  buildingId: number,
  input: { roomNumber: string; floorId: number | null },
): Promise<Room> {
  await requireBuilding(db, buildingId);
  // The database would also refuse a floor of another building (composite key), but
  // as a foreign-key error that does not say which rule failed.
  if (
    input.floorId !== null &&
    !(await exists(db, "SELECT 1 FROM floors WHERE id = $1 AND building_id = $2", [
      input.floorId,
      buildingId,
    ]))
  ) {
    throw new HttpError(404, "floor_not_found", "That floor is not part of this building.");
  }

  const roomNumber = input.roomNumber.trim();
  const [room] = await writeOr<Room>(
    db,
    `INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, $3) RETURNING ${ROOM}`,
    [buildingId, input.floorId, roomNumber],
    UNIQUE_VIOLATION,
    new HttpError(409, "room_exists", `This building already has a room ${roomNumber}.`),
  );
  return room;
}

export async function addBed(db: Queryable, roomId: number, bedNumber: string): Promise<Bed> {
  if (!(await exists(db, "SELECT 1 FROM rooms WHERE id = $1", [roomId]))) {
    throw new HttpError(404, "room_not_found", "That room no longer exists.");
  }
  const trimmed = bedNumber.trim();
  const [bed] = await writeOr<Bed>(
    db,
    `INSERT INTO beds (room_id, bed_number) VALUES ($1, $2) RETURNING ${BED}`,
    [roomId, trimmed],
    UNIQUE_VIOLATION,
    new HttpError(409, "bed_exists", `This room already has a bed ${trimmed}.`),
  );
  return bed;
}

const bedNotFound = () => new HttpError(404, "bed_not_found", "That bed no longer exists.");

export async function retireBed(db: Queryable, bedId: number): Promise<Bed> {
  // One statement does the check and the change, so a student cannot be placed in the
  // bed between them: the row is only updated while no current stay uses it.
  const { rows } = await db.query<Bed>(
    `UPDATE beds SET is_active = false
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM stays WHERE bed_id = $1 AND ended_on IS NULL)
     RETURNING ${BED}`,
    [bedId],
  );
  if (rows[0]) return rows[0];
  // Nothing updated: either the bed does not exist or someone sleeps in it.
  if (!(await exists(db, "SELECT 1 FROM beds WHERE id = $1", [bedId]))) throw bedNotFound();
  throw new HttpError(
    409,
    "bed_occupied",
    "A student currently has this bed. Move them before retiring it.",
  );
}

export async function reactivateBed(db: Queryable, bedId: number): Promise<Bed> {
  const { rows } = await db.query<Bed>(
    `UPDATE beds SET is_active = true WHERE id = $1 RETURNING ${BED}`,
    [bedId],
  );
  if (!rows[0]) throw bedNotFound();
  return rows[0];
}

export async function deleteBuilding(db: Queryable, buildingId: number): Promise<void> {
  await requireBuilding(db, buildingId);
  const inUse = new HttpError(
    409,
    "building_in_use",
    "Students have lived in this building, so it cannot be deleted. Its history must stay.",
  );
  if (await exists(db, "SELECT 1 FROM stays WHERE building_id = $1", [buildingId])) throw inUse;
  // Floors, rooms and beds go with it (ON DELETE CASCADE). The foreign keys from
  // stays still refuse if a stay was added since the check above.
  await writeOr(db, "DELETE FROM buildings WHERE id = $1", [buildingId], FOREIGN_KEY_VIOLATION, inUse);
}

export async function deleteFloor(db: Queryable, floorId: number): Promise<void> {
  if (!(await exists(db, "SELECT 1 FROM floors WHERE id = $1", [floorId]))) {
    throw new HttpError(404, "floor_not_found", "That floor no longer exists.");
  }
  const hasRooms = new HttpError(
    409,
    "floor_has_rooms",
    "This floor still has rooms. Delete or move them first.",
  );
  if (await exists(db, "SELECT 1 FROM rooms WHERE floor_id = $1", [floorId])) throw hasRooms;
  await writeOr(db, "DELETE FROM floors WHERE id = $1", [floorId], FOREIGN_KEY_VIOLATION, hasRooms);
}

export async function deleteRoom(db: Queryable, roomId: number): Promise<void> {
  if (!(await exists(db, "SELECT 1 FROM rooms WHERE id = $1", [roomId]))) {
    throw new HttpError(404, "room_not_found", "That room no longer exists.");
  }
  const inUse = new HttpError(
    409,
    "room_in_use",
    "Students have lived in this room, so it cannot be deleted. Retire its beds instead.",
  );
  if (await exists(db, "SELECT 1 FROM stays WHERE room_id = $1", [roomId])) throw inUse;
  // Its beds go with it (ON DELETE CASCADE).
  await writeOr(db, "DELETE FROM rooms WHERE id = $1", [roomId], FOREIGN_KEY_VIOLATION, inUse);
}

// Room and bed numbers are text ("101", "G1", "A"). Ordering by length first puts
// "9" before "10", which plain text order would not.
const NATURAL = (column: string) => `length(${column}), ${column}`;

export async function listStructure(db: Queryable): Promise<StructureBuilding[]> {
  // Four small queries, assembled here. A few hundred rows at most, so this is easier
  // to read than one query building nested JSON. One after another, not Promise.all:
  // db may be a single connection inside a transaction, which runs one query at a time.
  const buildings = await db.query<Building>(
    `SELECT ${BUILDING} FROM buildings ORDER BY lower(name)`,
  );
  const floors = await db.query<Floor>(`SELECT ${FLOOR} FROM floors ORDER BY number`);
  const rooms = await db.query<Room>(
    `SELECT ${ROOM} FROM rooms ORDER BY ${NATURAL("room_number")}`,
  );
  const beds = await db.query<StructureBed>(
    `SELECT ${BED},
            EXISTS (SELECT 1 FROM stays s WHERE s.bed_id = beds.id AND s.ended_on IS NULL)
              AS occupied
     FROM beds ORDER BY ${NATURAL("bed_number")}`,
  );

  // Group children under their parent id, keeping the order the queries gave.
  const group = <T, K>(items: T[], key: (item: T) => K) => {
    const map = new Map<K, T[]>();
    for (const item of items) {
      const list = map.get(key(item));
      if (list) list.push(item);
      else map.set(key(item), [item]);
    }
    return (k: K) => map.get(k) ?? [];
  };

  const bedsOf = group(beds.rows, (b) => b.roomId);
  const withBeds = rooms.rows.map((r): StructureRoom => ({ ...r, beds: bedsOf(r.id) }));
  const roomsOnFloor = group(withBeds, (r) => r.floorId);
  const floorlessRoomsOf = group(
    withBeds.filter((r) => r.floorId === null),
    (r) => r.buildingId,
  );
  const floorsOf = group(
    floors.rows.map((f): StructureFloor => ({ ...f, rooms: roomsOnFloor(f.id) })),
    (f) => f.buildingId,
  );

  return buildings.rows.map((b) => ({
    ...b,
    floors: floorsOf(b.id),
    rooms: floorlessRoomsOf(b.id),
  }));
}

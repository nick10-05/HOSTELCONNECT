import type { Queryable } from "../db";
import { HttpError } from "../lib/http";

// Hostel structure: buildings, floors, rooms and beds (design doc, section 3).
// YOU WRITE the function bodies. tests/structure.test.ts says exactly what each must do.
//
// Rules of thumb:
// - Every refusal is `throw new HttpError(status, code, message)`. The codes the tests
//   expect are listed on each function. Anything else thrown becomes a 500.
//   The owner's screen shows the message as is, so write it for the owner, e.g.
//   "Room 101 already exists in Block A." or "Students have lived in this room, so it
//   cannot be deleted."
// - Inputs arrive already validated by the route (types, lengths). Trim names here.
// - The database already enforces most rules (migration 003). You may either check
//   first and then write, or write and translate the Postgres error code
//   (23505 unique, 23503 foreign key) into an HttpError. Checking first is easier to
//   read; catching the error is also correct when two requests race. Note that a
//   failed statement inside a transaction aborts that transaction.
// - Use $1 placeholders, never string concatenation.

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

const notWritten = (name: string): never => {
  throw new Error(`structure.${name} is not written yet`);
};

// 409 building_exists if the name is taken, ignoring case.
export async function createBuilding(db: Queryable, name: string): Promise<Building> {
  return notWritten("createBuilding");
}

// 404 building_not_found, 409 floor_exists.
export async function addFloor(db: Queryable, buildingId: number, number: number): Promise<Floor> {
  return notWritten("addFloor");
}

// 404 building_not_found; 404 floor_not_found when floorId is not a floor of this
// building; 409 room_exists. floorId null = room straight under the building.
export async function addRoom(
  db: Queryable,
  buildingId: number,
  input: { roomNumber: string; floorId: number | null },
): Promise<Room> {
  return notWritten("addRoom");
}

// 404 room_not_found, 409 bed_exists. A new bed is active.
export async function addBed(db: Queryable, roomId: number, bedNumber: string): Promise<Bed> {
  return notWritten("addBed");
}

// Beds are never deleted, only retired. 404 bed_not_found; 409 bed_occupied while a
// current stay uses the bed. Retiring a retired bed is fine.
export async function retireBed(db: Queryable, bedId: number): Promise<Bed> {
  return notWritten("retireBed");
}

// Undo a retirement. 404 bed_not_found.
export async function reactivateBed(db: Queryable, bedId: number): Promise<Bed> {
  return notWritten("reactivateBed");
}

// 404 building_not_found; 409 building_in_use if any stay, current or ended, ever
// referenced it. Otherwise deletes it with its floors, rooms and beds.
export async function deleteBuilding(db: Queryable, buildingId: number): Promise<void> {
  return notWritten("deleteBuilding");
}

// 404 floor_not_found; 409 floor_has_rooms.
export async function deleteFloor(db: Queryable, floorId: number): Promise<void> {
  return notWritten("deleteFloor");
}

// 404 room_not_found; 409 room_in_use if any stay ever referenced it.
// Otherwise deletes it with its beds.
export async function deleteRoom(db: Queryable, roomId: number): Promise<void> {
  return notWritten("deleteRoom");
}

// Every building ordered by name; floors by number; rooms by room number; beds by bed
// number. A bed is occupied while a current stay (ended_on IS NULL) uses it.
export async function listStructure(db: Queryable): Promise<StructureBuilding[]> {
  return notWritten("listStructure");
}

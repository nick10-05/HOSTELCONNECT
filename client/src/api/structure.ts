import { apiFetch } from "./client";

// The owner's buildings, floors, rooms and beds. Shapes match server/src/services/structure.ts.

export type Bed = { id: number; roomId: number; bedNumber: string; isActive: boolean; occupied: boolean };
export type Room = {
  id: number;
  buildingId: number;
  floorId: number | null;
  roomNumber: string;
  beds: Bed[];
};
export type Floor = { id: number; buildingId: number; number: number; rooms: Room[] };
export type Building = {
  id: number;
  name: string;
  floors: Floor[];
  rooms: Room[]; // rooms straight under the building, without a floor
};

// GET /api/structure: every building with its floors, rooms and beds, in order.
export async function getStructure(): Promise<Building[]> {
  const { buildings } = await apiFetch<{ buildings: Building[] }>("/api/structure");
  return buildings;
}

// Each change below returns once the server has saved it; the page then reloads the
// whole tree, so it never shows a half-updated state. Refusals arrive as ApiError
// (409 "room_in_use", "bed_occupied", ...), whose message is shown as is.

export async function createBuilding(name: string): Promise<void> {
  await apiFetch("/api/buildings", { method: "POST", body: { name } });
}

export async function deleteBuilding(id: number): Promise<void> {
  await apiFetch(`/api/buildings/${id}`, { method: "DELETE" });
}

export async function addFloor(buildingId: number, number: number): Promise<void> {
  await apiFetch(`/api/buildings/${buildingId}/floors`, { method: "POST", body: { number } });
}

export async function deleteFloor(id: number): Promise<void> {
  await apiFetch(`/api/floors/${id}`, { method: "DELETE" });
}

export async function addRoom(buildingId: number, roomNumber: string, floorId: number | null): Promise<void> {
  await apiFetch(`/api/buildings/${buildingId}/rooms`, {
    method: "POST",
    body: { roomNumber, floorId },
  });
}

export async function deleteRoom(id: number): Promise<void> {
  await apiFetch(`/api/rooms/${id}`, { method: "DELETE" });
}

export async function addBed(roomId: number, bedNumber: string): Promise<void> {
  await apiFetch(`/api/rooms/${roomId}/beds`, { method: "POST", body: { bedNumber } });
}

export async function setBedActive(id: number, active: boolean): Promise<void> {
  await apiFetch(`/api/beds/${id}/${active ? "reactivate" : "retire"}`, { method: "POST" });
}

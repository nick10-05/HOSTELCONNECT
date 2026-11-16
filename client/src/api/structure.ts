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

export async function addBed(roomId: number, bedNumber: string): Promise<void> {
  await apiFetch(`/api/rooms/${roomId}/beds`, { method: "POST", body: { bedNumber } });
}

export async function setBedActive(id: number, active: boolean): Promise<void> {
  await apiFetch(`/api/beds/${id}/${active ? "reactivate" : "retire"}`, { method: "POST" });
}

// ---- Deleting a building or room for good (server/src/services/structureDeletion.ts). ----
// Three steps: see what would go, have a 6-digit code emailed to the owner, then delete
// with the code and the typed name. Past stays keep the names of where they were.

export type DeletionKind = "building" | "room";

export type DeletionPreview = {
  kind: DeletionKind;
  id: number;
  name: string; // "Block A", or "Block A · Room 101"
  confirmName: string; // what the owner types: the building's name or the room number
  floors: number;
  rooms: number;
  beds: number;
  pastStays: number;
  currentStays: number; // the server refuses while any are current or booked
  emailReady: boolean; // false: the server cannot send codes, so deleting is off
};

export type SentCode = {
  codeId: string;
  expiresAt: string; // ISO time, UTC
  resendAfterSeconds: number;
  sentTo: string; // the owner's address, partly hidden: "ni•••@gmail.com"
};

const deletionPath = (kind: DeletionKind, id: number) => `/api/${kind === "building" ? "buildings" : "rooms"}/${id}`;

export async function getDeletionPreview(kind: DeletionKind, id: number): Promise<DeletionPreview> {
  const { deletion } = await apiFetch<{ deletion: DeletionPreview }>(`${deletionPath(kind, id)}/deletion`);
  return deletion;
}

// Refusals: 400 "confirm_name_mismatch", 409 "<kind>_occupied", 429 "code_too_soon" or
// "too_many_codes", 502 "email_failed", 503 "email_not_set_up".
export async function requestDeletionCode(kind: DeletionKind, id: number, confirmName: string): Promise<SentCode> {
  const { code } = await apiFetch<{ code: SentCode }>(`${deletionPath(kind, id)}/delete-code`, {
    method: "POST",
    body: { confirmName },
  });
  return code;
}

// Refusals: 400 "wrong_code" (the message says how many tries are left), 410
// "code_expired" / "code_used_up" / "code_not_valid" (ask for a new code), 409 occupied.
export async function deleteWithCode(
  kind: DeletionKind,
  id: number,
  input: { confirmName: string; codeId: string; code: string },
): Promise<void> {
  await apiFetch(deletionPath(kind, id), { method: "DELETE", body: input });
}

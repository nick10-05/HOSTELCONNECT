import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { HttpError } from "../src/lib/http";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import * as structure from "../src/services/structure";
import { hostelTx, insertOwner, insertStudent, testPool } from "./helpers/db";

// The HTTP layer only: who may call, input checks, status codes and answer shapes.
// The service functions are replaced by mocks here; tests/structure.test.ts checks the
// real rules against the database. Login is real, so the users are real rows.
vi.mock("../src/services/structure", () => ({
  listStructure: vi.fn(),
  createBuilding: vi.fn(),
  deleteBuilding: vi.fn(),
  addFloor: vi.fn(),
  deleteFloor: vi.fn(),
  addRoom: vi.fn(),
  deleteRoom: vi.fn(),
  addBed: vi.fn(),
  retireBed: vi.fn(),
  reactivateBed: vi.fn(),
}));
const service = vi.mocked(structure);

const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());
beforeEach(() => vi.clearAllMocks());

const app = createApp({ db, jwtSecret: SECRET });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;
const asOwner = async () => cookieFor(await insertOwner(db), "owner");

const bed = { id: 3, roomId: 2, bedNumber: "A", isActive: true };

describe("who may use the structure endpoints", () => {
  it("answers 401 without a session", async () => {
    const res = await request(app).get("/api/structure");
    expect(res.status).toBe(401);
  });

  it("answers 403 to a student", async () => {
    const student = await insertStudent(db);
    const res = await request(app)
      .post("/api/buildings")
      .set("Cookie", cookieFor(student, "student"))
      .send({ name: "Block A" });
    expect(res.status).toBe(403);
    expect(service.createBuilding).not.toHaveBeenCalled();
  });
});

describe("structure endpoints for the owner", () => {
  it("GET /api/structure returns the tree", async () => {
    service.listStructure.mockResolvedValue([]);
    const res = await request(app).get("/api/structure").set("Cookie", await asOwner());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buildings: [] });
  });

  it("POST /api/buildings creates a building", async () => {
    service.createBuilding.mockResolvedValue({ id: 1, name: "Block A" });
    const res = await request(app)
      .post("/api/buildings")
      .set("Cookie", await asOwner())
      .send({ name: "  Block A " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ building: { id: 1, name: "Block A" } });
    expect(service.createBuilding).toHaveBeenCalledWith(hostelTx(db), "Block A");
  });

  it("refuses a blank or missing name before reaching the service", async () => {
    const cookie = await asOwner();
    for (const body of [{ name: "   " }, {}, { name: "x".repeat(101) }]) {
      const res = await request(app).post("/api/buildings").set("Cookie", cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_input");
    }
    expect(service.createBuilding).not.toHaveBeenCalled();
  });

  it("passes a service refusal through unchanged", async () => {
    service.createBuilding.mockRejectedValue(
      new HttpError(409, "building_exists", "A building with this name already exists."),
    );
    const res = await request(app)
      .post("/api/buildings")
      .set("Cookie", await asOwner())
      .send({ name: "Block A" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("building_exists");
  });

  it("POST /api/buildings/:id/floors adds a floor", async () => {
    service.addFloor.mockResolvedValue({ id: 4, buildingId: 1, number: 0 });
    const res = await request(app)
      .post("/api/buildings/1/floors")
      .set("Cookie", await asOwner())
      .send({ number: 0 });
    expect(res.status).toBe(201);
    expect(res.body.floor.number).toBe(0);
    expect(service.addFloor).toHaveBeenCalledWith(hostelTx(db), 1, 0);
  });

  it("refuses a floor number that is not a whole number", async () => {
    const res = await request(app)
      .post("/api/buildings/1/floors")
      .set("Cookie", await asOwner())
      .send({ number: 1.5 });
    expect(res.status).toBe(400);
  });

  it("POST /api/buildings/:id/rooms adds a room, without a floor when none is given", async () => {
    service.addRoom.mockResolvedValue({ id: 2, buildingId: 1, floorId: null, roomNumber: "G1" });
    const res = await request(app)
      .post("/api/buildings/1/rooms")
      .set("Cookie", await asOwner())
      .send({ roomNumber: "G1" });
    expect(res.status).toBe(201);
    expect(service.addRoom).toHaveBeenCalledWith(hostelTx(db), 1, { roomNumber: "G1", floorId: null });
  });

  it("POST /api/rooms/:id/beds adds a bed", async () => {
    service.addBed.mockResolvedValue(bed);
    const res = await request(app)
      .post("/api/rooms/2/beds")
      .set("Cookie", await asOwner())
      .send({ bedNumber: "A" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ bed });
    expect(service.addBed).toHaveBeenCalledWith(hostelTx(db), 2, "A");
  });

  it("POST /api/beds/:id/retire and /reactivate return the bed", async () => {
    const cookie = await asOwner();
    service.retireBed.mockResolvedValue({ ...bed, isActive: false });
    service.reactivateBed.mockResolvedValue(bed);
    const retired = await request(app).post("/api/beds/3/retire").set("Cookie", cookie);
    expect(retired.status).toBe(200);
    expect(retired.body.bed.isActive).toBe(false);
    const back = await request(app).post("/api/beds/3/reactivate").set("Cookie", cookie);
    expect(back.body.bed.isActive).toBe(true);
  });

  it("DELETE answers 204 for buildings, floors and rooms", async () => {
    const cookie = await asOwner();
    for (const path of ["/api/buildings/1", "/api/floors/4", "/api/rooms/2"]) {
      const res = await request(app).delete(path).set("Cookie", cookie);
      expect(res.status, path).toBe(204);
    }
    expect(service.deleteBuilding).toHaveBeenCalledWith(hostelTx(db), 1);
    expect(service.deleteFloor).toHaveBeenCalledWith(hostelTx(db), 4);
    expect(service.deleteRoom).toHaveBeenCalledWith(hostelTx(db), 2);
  });

  it("answers 404 for an id that is not a positive whole number", async () => {
    const cookie = await asOwner();
    for (const path of ["/api/buildings/abc", "/api/rooms/0", "/api/floors/-1", "/api/buildings/1e3"]) {
      const res = await request(app).delete(path).set("Cookie", cookie);
      expect(res.status, path).toBe(404);
    }
    expect(service.deleteBuilding).not.toHaveBeenCalled();
  });
});

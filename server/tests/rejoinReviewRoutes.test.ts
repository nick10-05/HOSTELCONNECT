import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { addDays, hostelToday } from "../src/lib/dates";
import { HttpError } from "../src/lib/http";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import * as rejoin from "../src/services/rejoin";
import type { Admission } from "../src/services/students";
import { hostelTx, insertOwner, insertStudent, testPool } from "./helpers/db";

// The HTTP layer of the owner's review: who may call, input checks, status codes and the
// answer. The services are mocks here; tests/rejoinReview.test.ts checks them against
// the database. Login is real, so the users are real rows.
vi.mock("../src/services/rejoin", () => ({
  requestRejoin: vi.fn(),
  listRejoinRequests: vi.fn(),
  approveRejoinRequest: vi.fn(),
  rejectRejoinRequest: vi.fn(),
}));
const service = vi.mocked(rejoin);

const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());
beforeEach(() => vi.clearAllMocks());

const app = createApp({ db, jwtSecret: SECRET });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;
const asOwner = async () => cookieFor(await insertOwner(db), "owner");
const asStudent = async () => cookieFor(await insertStudent(db), "student");

describe("who may review requests", () => {
  it.each([
    ["list", "get", "/api/rejoin-requests"],
    ["approve", "post", "/api/rejoin-requests/3/approve"],
    ["reject", "post", "/api/rejoin-requests/3/reject"],
  ] as const)("only the owner may %s", async (_name, method, path) => {
    expect((await request(app)[method](path).send({})).status).toBe(401);
    expect((await request(app)[method](path).set("Cookie", await asStudent()).send({})).status).toBe(403);
    expect(service.listRejoinRequests).not.toHaveBeenCalled();
    expect(service.approveRejoinRequest).not.toHaveBeenCalled();
    expect(service.rejectRejoinRequest).not.toHaveBeenCalled();
  });
});

describe("GET /api/rejoin-requests", () => {
  const get = async (query: string) =>
    request(app).get(`/api/rejoin-requests${query}`).set("Cookie", await asOwner());

  it("lists pending requests, 20 per page, when nothing is asked", async () => {
    service.listRejoinRequests.mockResolvedValue({ items: [], total: 0 });
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
    expect(service.listRejoinRequests).toHaveBeenCalledWith(hostelTx(db), { status: "pending", page: 1, limit: 20 });
  });

  it("passes the status and paging on", async () => {
    service.listRejoinRequests.mockResolvedValue({ items: [], total: 0 });
    await get("?status=decided&page=2&limit=50");
    expect(service.listRejoinRequests.mock.calls[0][1]).toEqual({ status: "decided", page: 2, limit: 50 });
  });

  it.each([
    ["an unknown status", "?status=approved"],
    ["page 0", "?page=0"],
    ["limit above 50", "?limit=51"],
  ])("refuses %s with 400", async (_name, query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(service.listRejoinRequests).not.toHaveBeenCalled();
  });
});

describe("POST /api/rejoin-requests/:id/approve", () => {
  const approved: Admission = {
    student: { id: 7, name: "Ravi Kumar", email: "ravi@example.com", joiningDate: hostelToday(), buildingId: 1, roomId: null, bedId: null },
    temporaryPassword: "ABCD234567",
  };

  it("approves with the owner from the session and returns the password once, never cached", async () => {
    service.approveRejoinRequest.mockResolvedValue(approved);
    const owner = await insertOwner(db);
    const body = { joiningDate: hostelToday(), buildingId: 1, roomId: 4, bedId: 9 };
    const res = await request(app)
      .post("/api/rejoin-requests/3/approve")
      .set("Cookie", cookieFor(owner, "owner"))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(approved);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(service.approveRejoinRequest).toHaveBeenCalledWith(hostelTx(db), owner, 3, body);
  });

  it.each([
    ["a missing joining date", { buildingId: 1 }, "joiningDate"],
    ["a joining date more than 30 days ahead", { joiningDate: addDays(hostelToday(), 31), buildingId: 1 }, "joiningDate"],
    ["a missing building", { joiningDate: hostelToday() }, "buildingId"],
    ["a bed without a room", { joiningDate: hostelToday(), buildingId: 1, bedId: 9 }, "roomId"],
  ])("refuses %s with 400, as a reactivation does", async (_name, body, field) => {
    const res = await request(app).post("/api/rejoin-requests/3/approve").set("Cookie", await asOwner()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(field);
    expect(service.approveRejoinRequest).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a positive number", async () => {
    const res = await request(app)
      .post("/api/rejoin-requests/abc/approve")
      .set("Cookie", await asOwner())
      .send({ joiningDate: hostelToday(), buildingId: 1 });
    expect(res.status).toBe(404);
    expect(service.approveRejoinRequest).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on as the normal error answer", async () => {
    service.approveRejoinRequest.mockRejectedValue(
      new HttpError(409, "request_decided", "This request has already been rejected."),
    );
    const res = await request(app)
      .post("/api/rejoin-requests/3/approve")
      .set("Cookie", await asOwner())
      .send({ joiningDate: hostelToday(), buildingId: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "request_decided", message: "This request has already been rejected." } });
  });
});

describe("POST /api/rejoin-requests/:id/reject", () => {
  it("rejects with the owner from the session and answers 204", async () => {
    service.rejectRejoinRequest.mockResolvedValue(undefined);
    const owner = await insertOwner(db);
    const res = await request(app).post("/api/rejoin-requests/3/reject").set("Cookie", cookieFor(owner, "owner")).send({});
    expect(res.status).toBe(204);
    expect(service.rejectRejoinRequest).toHaveBeenCalledWith(hostelTx(db), owner, 3);
  });

  it("passes the service's refusal on", async () => {
    service.rejectRejoinRequest.mockRejectedValue(new HttpError(404, "request_not_found", "That request does not exist."));
    const res = await request(app).post("/api/rejoin-requests/3/reject").set("Cookie", await asOwner()).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("request_not_found");
  });

  it("refuses a cross-site request", async () => {
    const res = await request(app)
      .post("/api/rejoin-requests/3/reject")
      .set("Cookie", await asOwner())
      .set("Origin", "https://elsewhere.example")
      .send({});
    expect(res.status).toBe(403);
    expect(service.rejectRejoinRequest).not.toHaveBeenCalled();
  });
});

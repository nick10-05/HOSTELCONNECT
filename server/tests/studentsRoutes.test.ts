import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { addDays, hostelToday } from "../src/lib/dates";
import { HttpError } from "../src/lib/http";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import * as students from "../src/services/students";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// The HTTP layer of POST /api/students: who may call, input checks and cleaning, status
// codes and the answer. The service is a mock here; tests/students.test.ts checks the
// real admission against the database. Login is real, so the users are real rows.
vi.mock("../src/services/students", () => ({
  admitStudent: vi.fn(),
  listStudents: vi.fn(),
  getStudent: vi.fn(),
  transferStudent: vi.fn(),
  deactivateStudent: vi.fn(),
  reactivateStudent: vi.fn(),
}));
const service = vi.mocked(students);

const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());
beforeEach(() => vi.clearAllMocks());

const app = createApp({ db, jwtSecret: SECRET });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;
const asOwner = async () => cookieFor(await insertOwner(db), "owner");

// A complete, valid form for a college student, as the browser sends it.
const form = (overrides: Record<string, unknown> = {}) => ({
  name: "Asha Rao",
  email: "asha@example.com",
  phone: "9876543210",
  parentPhone: "9876500000",
  category: "college",
  collegeName: "City College",
  branch: "CSE",
  academicYear: 2,
  joiningDate: "2026-01-31",
  foodPreference: "veg",
  monthlyFee: 6500,
  buildingId: 1,
  ...overrides,
});

const admission: students.Admission = {
  student: {
    id: 7,
    name: "Asha Rao",
    email: "asha@example.com",
    joiningDate: "2026-01-31",
    buildingId: 1,
    roomId: null,
    bedId: null,
  },
  temporaryPassword: "ABCD234567",
};

const post = async (body: unknown, cookie?: string) =>
  request(app)
    .post("/api/students")
    .set("Cookie", cookie ?? (await asOwner()))
    .send(body as object);

describe("who may admit students", () => {
  it("answers 401 without a session", async () => {
    const res = await request(app).post("/api/students").send(form());
    expect(res.status).toBe(401);
    expect(service.admitStudent).not.toHaveBeenCalled();
  });

  it("answers 403 to a student", async () => {
    const student = await insertStudent(db);
    const res = await post(form(), cookieFor(student, "student"));
    expect(res.status).toBe(403);
    expect(service.admitStudent).not.toHaveBeenCalled();
  });
});

describe("POST /api/students", () => {
  it("admits the student and returns the temporary password once, never cached", async () => {
    service.admitStudent.mockResolvedValue(admission);
    const owner = await insertOwner(db);
    const res = await post(form(), cookieFor(owner, "owner"));

    expect(res.status).toBe(201);
    expect(res.body).toEqual(admission);
    expect(res.headers["cache-control"]).toBe("no-store");
    // The owner's id comes from the session, never from the form.
    expect(service.admitStudent).toHaveBeenCalledWith(db, owner, {
      name: "Asha Rao",
      email: "asha@example.com",
      phone: "9876543210",
      parentPhone: "9876500000",
      category: "college",
      collegeName: "City College",
      branch: "CSE",
      academicYear: 2,
      company: null,
      designation: null,
      joiningDate: "2026-01-31",
      foodPreference: "veg",
      vegDays: [],
      monthlyFee: 6500,
      buildingId: 1,
      roomId: null,
      bedId: null,
    });
  });

  it("cleans the form: trims text, lower-cases the email, keeps 10 phone digits", async () => {
    service.admitStudent.mockResolvedValue(admission);
    await post(
      form({
        name: "  Asha Rao ",
        email: " Asha@Example.COM ",
        phone: "+91 98765-43210",
        parentPhone: "+919876500000",
        roomId: 4,
        bedId: 9,
      }),
    );
    expect(service.admitStudent.mock.calls[0][2]).toMatchObject({
      name: "Asha Rao",
      email: "asha@example.com",
      phone: "9876543210",
      parentPhone: "9876500000",
      roomId: 4,
      bedId: 9,
    });
  });

  it("keeps only the fields of the chosen category", async () => {
    service.admitStudent.mockResolvedValue(admission);
    // A form that still holds college fields after switching to "working".
    await post(form({ category: "working", company: "Acme", designation: "Analyst" }));
    expect(service.admitStudent.mock.calls[0][2]).toMatchObject({
      category: "working",
      company: "Acme",
      designation: "Analyst",
      collegeName: null,
      branch: null,
      academicYear: null,
    });

    await post(form({ category: "other", company: "Acme" }));
    expect(service.admitStudent.mock.calls[1][2]).toMatchObject({
      category: "other",
      company: null,
      collegeName: null,
    });
  });

  it("takes a non-veg student's veg days, sorted Monday first", async () => {
    service.admitStudent.mockResolvedValue(admission);
    const res = await post(form({ foodPreference: "non_veg", vegDays: [6, 2] }));
    expect(res.status).toBe(201);
    expect(service.admitStudent.mock.calls[0][2]).toMatchObject({ foodPreference: "non_veg", vegDays: [2, 6] });
  });

  it("does not need a designation for a working professional", async () => {
    service.admitStudent.mockResolvedValue(admission);
    const res = await post(form({ category: "working", company: "Acme" }));
    expect(res.status).toBe(201);
    expect(service.admitStudent.mock.calls[0][2]).toMatchObject({ designation: null });
  });

  it("allows a joining date up to 30 days ahead and any past date", async () => {
    service.admitStudent.mockResolvedValue(admission);
    for (const joiningDate of [addDays(hostelToday(), 10), "2019-07-01"]) {
      const res = await post(form({ joiningDate }));
      expect(res.status).toBe(201);
    }
  });

  // Each case names the field the 400 message must mention.
  const invalid: [string, Record<string, unknown>, string][] = [
    ["missing name", { name: "  " }, "name"],
    ["bad email", { email: "not-an-email" }, "email"],
    ["short phone", { phone: "98765" }, "phone"],
    ["phone not starting 6-9", { phone: "5876543210" }, "phone"],
    ["landline-style parent phone", { parentPhone: "0802345678" }, "parentPhone"],
    ["unknown category", { category: "retired" }, "category"],
    ["college without college name", { collegeName: undefined }, "collegeName"],
    ["college without branch", { branch: "" }, "branch"],
    ["college without year", { academicYear: undefined }, "academicYear"],
    ["year out of range", { academicYear: 9 }, "academicYear"],
    ["working without company", { category: "working" }, "company"],
    ["date in the wrong format", { joiningDate: "31/01/2026" }, "joiningDate"],
    ["a day that does not exist", { joiningDate: "2026-02-30" }, "joiningDate"],
    ["joining more than 30 days ahead", { joiningDate: addDays(hostelToday(), 60) }, "joiningDate"],
    ["unknown food preference", { foodPreference: "vegan" }, "foodPreference"],
    ["veg days for a veg student", { vegDays: [2] }, "vegDays"],
    ["a veg day that is not a weekday", { foodPreference: "non_veg", vegDays: [8] }, "vegDays"],
    ["a veg day listed twice", { foodPreference: "non_veg", vegDays: [2, 2] }, "vegDays"],
    ["negative fee", { monthlyFee: -1 }, "monthlyFee"],
    ["fee with paise", { monthlyFee: 6500.5 }, "monthlyFee"],
    ["missing building", { buildingId: undefined }, "buildingId"],
    ["bed without a room", { bedId: 3 }, "roomId"],
  ];

  it.each(invalid)("refuses %s with 400 before reaching the service", async (_name, overrides, field) => {
    const res = await post(form(overrides));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(res.body.error.message).toContain(field);
    expect(service.admitStudent).not.toHaveBeenCalled();
  });

  it("never repeats the submitted phone number in an error message", async () => {
    const res = await post(form({ phone: "98765123" }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).not.toContain("98765123");
  });

  it("passes the service's refusal on as the normal error answer", async () => {
    service.admitStudent.mockRejectedValue(
      new HttpError(409, "bed_occupied", "That bed already has a student."),
    );
    const res = await post(form({ roomId: 4, bedId: 9 }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "bed_occupied", message: "That bed already has a student." },
    });
  });
});

describe("GET /api/students", () => {
  const get = async (query: string, cookie?: string) =>
    request(app)
      .get(`/api/students${query}`)
      .set("Cookie", cookie ?? (await asOwner()));

  it("needs the owner", async () => {
    expect((await request(app).get("/api/students")).status).toBe(401);
    const student = await insertStudent(db);
    expect((await get("", cookieFor(student, "student"))).status).toBe(403);
    expect(service.listStudents).not.toHaveBeenCalled();
  });

  it("lists active students, 20 per page, when nothing is asked", async () => {
    service.listStudents.mockResolvedValue({ items: [], total: 0 });
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
    expect(service.listStudents).toHaveBeenCalledWith(db, {
      search: null,
      buildingId: null,
      floorId: null,
      roomId: null,
      category: null,
      active: true,
      page: 1,
      limit: 20,
    });
  });

  it("passes search, filters and paging on", async () => {
    service.listStudents.mockResolvedValue({ items: [], total: 0 });
    await get("?search=%20asha%20&buildingId=2&floorId=3&roomId=4&category=college&status=all&page=3&limit=50");
    expect(service.listStudents.mock.calls[0][1]).toEqual({
      search: "asha",
      buildingId: 2,
      floorId: 3,
      roomId: 4,
      category: "college",
      active: null,
      page: 3,
      limit: 50,
    });

    await get("?status=former&search=");
    expect(service.listStudents.mock.calls[1][1]).toMatchObject({ active: false, search: null });
  });

  it.each([
    ["limit above 50", "?limit=51"],
    ["page 0", "?page=0"],
    ["a building id that is not a number", "?buildingId=abc"],
    ["an unknown category", "?category=retired"],
    ["an unknown status", "?status=everyone"],
  ])("refuses %s with 400", async (_name, query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(service.listStudents).not.toHaveBeenCalled();
  });
});

describe("GET /api/students/:id", () => {
  it("returns the profile, never cached, with India's date for the next due date", async () => {
    service.getStudent.mockResolvedValue({ id: 7 } as never);
    const res = await request(app).get("/api/students/7").set("Cookie", await asOwner());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ student: { id: 7 } });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(service.getStudent).toHaveBeenCalledWith(db, 7, hostelToday());
  });

  it("answers 404 for an id that is not a positive number", async () => {
    const res = await request(app).get("/api/students/abc").set("Cookie", await asOwner());
    expect(res.status).toBe(404);
    expect(service.getStudent).not.toHaveBeenCalled();
  });

  it("is for the owner only", async () => {
    const student = await insertStudent(db);
    const res = await request(app).get(`/api/students/${student}`).set("Cookie", cookieFor(student, "student"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/students/:id/transfer", () => {
  const transfer = async (id: string, body: unknown, cookie?: string) =>
    request(app)
      .post(`/api/students/${id}/transfer`)
      .set("Cookie", cookie ?? (await asOwner()))
      .send(body as object);

  const moved: students.TransferredStay = {
    kind: "transferred",
    id: 12,
    buildingId: 2,
    roomId: 4,
    bedId: 9,
    startedOn: hostelToday(),
  };

  it("needs the owner", async () => {
    expect((await request(app).post("/api/students/7/transfer").send({ buildingId: 2 })).status).toBe(401);
    const student = await insertStudent(db);
    expect((await transfer("7", { buildingId: 2 }, cookieFor(student, "student"))).status).toBe(403);
    expect(service.transferStudent).not.toHaveBeenCalled();
  });

  it("transfers with the owner from the session and India's date for today", async () => {
    service.transferStudent.mockResolvedValue(moved);
    const owner = await insertOwner(db);
    const res = await transfer("7", { buildingId: 2, roomId: 4, bedId: 9 }, cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transfer: moved });
    expect(service.transferStudent).toHaveBeenCalledWith(
      db,
      owner,
      7,
      { buildingId: 2, roomId: 4, bedId: 9 },
      hostelToday(),
    );
  });

  it("treats a missing room and bed as none, and answers a reassignment the same way", async () => {
    const reassigned = { ...moved, kind: "reassigned" as const, roomId: null, bedId: null, startedOn: "2099-12-01" };
    service.transferStudent.mockResolvedValue(reassigned);
    const res = await transfer("7", { buildingId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transfer: reassigned });
    expect(service.transferStudent.mock.calls[0][3]).toEqual({ buildingId: 2, roomId: null, bedId: null });
  });

  it.each([
    ["missing building", {}, "buildingId"],
    ["building id that is not a number", { buildingId: "2" }, "buildingId"],
    ["bed without a room", { buildingId: 2, bedId: 9 }, "roomId"],
    ["negative room id", { buildingId: 2, roomId: -4 }, "roomId"],
  ])("refuses a %s with 400 before reaching the service", async (_name, body, field) => {
    const res = await transfer("7", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(res.body.error.message).toContain(field);
    expect(service.transferStudent).not.toHaveBeenCalled();
  });

  it("answers 404 for a student id that is not a positive number", async () => {
    const res = await transfer("abc", { buildingId: 2 });
    expect(res.status).toBe(404);
    expect(service.transferStudent).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on as the normal error answer", async () => {
    service.transferStudent.mockRejectedValue(
      new HttpError(409, "bed_occupied", "The selected bed is already occupied."),
    );
    const res = await transfer("7", { buildingId: 2, roomId: 4, bedId: 9 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "bed_occupied", message: "The selected bed is already occupied." },
    });
  });

  it("refuses a cross-site request", async () => {
    const res = await request(app)
      .post("/api/students/7/transfer")
      .set("Cookie", await asOwner())
      .set("Origin", "https://elsewhere.example")
      .send({ buildingId: 2 });
    expect(res.status).toBe(403);
    expect(service.transferStudent).not.toHaveBeenCalled();
  });
});

describe("POST /api/students/:id/deactivate", () => {
  const deactivate = async (id: string, cookie?: string) =>
    request(app)
      .post(`/api/students/${id}/deactivate`)
      .set("Cookie", cookie ?? (await asOwner()))
      .send({});

  it("needs the owner", async () => {
    expect((await request(app).post("/api/students/7/deactivate").send({})).status).toBe(401);
    const student = await insertStudent(db);
    expect((await deactivate("7", cookieFor(student, "student"))).status).toBe(403);
    expect(service.deactivateStudent).not.toHaveBeenCalled();
  });

  it("moves the student out with India's date for today and answers 204", async () => {
    service.deactivateStudent.mockResolvedValue(undefined);
    const res = await deactivate("7");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(service.deactivateStudent).toHaveBeenCalledWith(db, 7, hostelToday());
  });

  it("answers 404 for an id that is not a positive number", async () => {
    const res = await deactivate("abc");
    expect(res.status).toBe(404);
    expect(service.deactivateStudent).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on as the normal error answer", async () => {
    service.deactivateStudent.mockRejectedValue(
      new HttpError(409, "student_inactive", "This student has already moved out."),
    );
    const res = await deactivate("7");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "student_inactive", message: "This student has already moved out." } });
  });

  it("refuses a cross-site request", async () => {
    const res = await request(app)
      .post("/api/students/7/deactivate")
      .set("Cookie", await asOwner())
      .set("Origin", "https://elsewhere.example")
      .send({});
    expect(res.status).toBe(403);
    expect(service.deactivateStudent).not.toHaveBeenCalled();
  });
});

describe("POST /api/students/:id/reactivate", () => {
  const reactivate = async (id: string, body: unknown, cookie?: string) =>
    request(app)
      .post(`/api/students/${id}/reactivate`)
      .set("Cookie", cookie ?? (await asOwner()))
      .send(body as object);

  const back: students.Admission = { ...admission, student: { ...admission.student, joiningDate: hostelToday() } };

  it("needs the owner", async () => {
    const body = { joiningDate: hostelToday(), buildingId: 1 };
    expect((await request(app).post("/api/students/7/reactivate").send(body)).status).toBe(401);
    const student = await insertStudent(db);
    expect((await reactivate("7", body, cookieFor(student, "student"))).status).toBe(403);
    expect(service.reactivateStudent).not.toHaveBeenCalled();
  });

  it("reactivates with the owner from the session and returns the password once, never cached", async () => {
    service.reactivateStudent.mockResolvedValue(back);
    const owner = await insertOwner(db);
    const body = { joiningDate: hostelToday(), buildingId: 1, roomId: 4, bedId: 9 };
    const res = await reactivate("7", body, cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(back);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(service.reactivateStudent).toHaveBeenCalledWith(db, owner, 7, body);
  });

  it("treats a missing room and bed as none, and accepts any past date or up to 30 days ahead", async () => {
    service.reactivateStudent.mockResolvedValue(back);
    for (const joiningDate of ["2019-07-01", addDays(hostelToday(), 30)]) {
      const res = await reactivate("7", { joiningDate, buildingId: 1 });
      expect(res.status).toBe(200);
    }
    expect(service.reactivateStudent.mock.calls[0][3]).toEqual({
      joiningDate: "2019-07-01",
      buildingId: 1,
      roomId: null,
      bedId: null,
    });
  });

  it.each([
    ["missing joining date", { buildingId: 1 }, "joiningDate"],
    ["date in the wrong format", { joiningDate: "04/11/2026", buildingId: 1 }, "joiningDate"],
    ["a day that does not exist", { joiningDate: "2026-02-30", buildingId: 1 }, "joiningDate"],
    ["joining more than 30 days ahead", { joiningDate: addDays(hostelToday(), 31), buildingId: 1 }, "joiningDate"],
    ["missing building", { joiningDate: hostelToday() }, "buildingId"],
    ["bed without a room", { joiningDate: hostelToday(), buildingId: 1, bedId: 9 }, "roomId"],
  ])("refuses a %s with 400 before reaching the service", async (_name, body, field) => {
    const res = await reactivate("7", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(res.body.error.message).toContain(field);
    expect(service.reactivateStudent).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a positive number", async () => {
    const res = await reactivate("abc", { joiningDate: hostelToday(), buildingId: 1 });
    expect(res.status).toBe(404);
    expect(service.reactivateStudent).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on as the normal error answer", async () => {
    service.reactivateStudent.mockRejectedValue(
      new HttpError(409, "joining_before_leaving", "The joining date cannot be before the student's last leaving date."),
    );
    const res = await reactivate("7", { joiningDate: "2019-07-01", buildingId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("joining_before_leaving");
  });

  it("refuses a cross-site request", async () => {
    const res = await request(app)
      .post("/api/students/7/reactivate")
      .set("Cookie", await asOwner())
      .set("Origin", "https://elsewhere.example")
      .send({ joiningDate: hostelToday(), buildingId: 1 });
    expect(res.status).toBe(403);
    expect(service.reactivateStudent).not.toHaveBeenCalled();
  });
});

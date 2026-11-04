import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  admitStudent,
  getStudent,
  listStudents,
  type AdmissionInput,
  type StudentFilters,
} from "../src/services/students";
import { insertOwner, insertStructure, testPool } from "./helpers/db";

// The owner's directory and profile in src/services/students.ts. Other test files add
// students to the same database at the same time, so every list here is narrowed to
// this file's own buildings.
const db = testPool();
afterAll(() => db.end());

const TODAY = "2026-11-04";
// Letters only, so a search for "101" can never match it inside an email address.
const tag = Array.from(randomUUID().replace(/-/g, "").slice(0, 10), (c) =>
  String.fromCharCode(97 + (parseInt(c, 16) % 26)),
).join("");

let owner: number;
let a: Awaited<ReturnType<typeof insertStructure>>; // floor 1, room 101, beds A and B
let b: Awaited<ReturnType<typeof insertStructure>>;
const ids: Record<string, number> = {};

const admit = async (key: string, overrides: Partial<AdmissionInput> & { buildingId: number }) => {
  const { student } = await admitStudent(db, owner, {
    name: key,
    email: `${key.toLowerCase().replace(/\W+/g, ".")}-${tag}@test.local`,
    phone: "9876543210",
    parentPhone: "9876500000",
    category: "other",
    collegeName: null,
    branch: null,
    academicYear: null,
    company: null,
    designation: null,
    joiningDate: "2026-01-31",
    foodPreference: "veg",
    vegDays: [],
    monthlyFee: 6500,
    roomId: null,
    bedId: null,
    ...overrides,
  });
  ids[key] = student.id;
};

beforeAll(async () => {
  owner = await insertOwner(db);
  a = await insertStructure(db);
  b = await insertStructure(db);
  await admit("Asha Rao", {
    buildingId: a.building,
    roomId: a.room,
    bedId: a.bed1,
    category: "college",
    collegeName: "City College",
    branch: "CSE",
    academicYear: 2,
  });
  await admit("bina Shah", { buildingId: a.building, roomId: a.room, category: "working", company: "Acme" });
  await admit("Chetan 50%_Off", { buildingId: a.building });
  await admit("Deepa Iyer", { buildingId: b.building, roomId: b.room, bedId: b.bed2 });
  // Left the hostel: no current stay, cannot log in.
  await admit("Esha Former", { buildingId: a.building, roomId: a.room, bedId: a.bed2 });
  await db.query(
    "UPDATE stays SET ended_on = '2026-06-30' WHERE student_id = $1 AND ended_on IS NULL",
    [ids["Esha Former"]],
  );
  await db.query("UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1", [
    ids["Esha Former"],
  ]);
}, 60_000);

const filters = (f: Partial<StudentFilters> = {}): StudentFilters => ({
  search: null,
  buildingId: null,
  floorId: null,
  roomId: null,
  category: null,
  active: true,
  page: 1,
  limit: 20,
  ...f,
});

// Names in this file's two buildings, for lists that may contain other files' students.
const names = async (f: Partial<StudentFilters>) => (await listStudents(db, filters(f))).items.map((s) => s.name);

describe("listStudents", () => {
  it("lists active students of a building by name, ignoring case, with where each lives", async () => {
    const page = await listStudents(db, filters({ buildingId: a.building }));
    expect(page.total).toBe(3);
    expect(page.items.map((s) => s.name)).toEqual(["Asha Rao", "bina Shah", "Chetan 50%_Off"]);

    expect(page.items[0]).toEqual({
      id: ids["Asha Rao"],
      name: "Asha Rao",
      email: `asha.rao-${tag}@test.local`,
      category: "college",
      joiningDate: "2026-01-31",
      isActive: true,
      place: {
        buildingId: a.building,
        buildingName: a.buildingName,
        floorNumber: 1,
        roomId: a.room,
        roomNumber: "101",
        bedId: a.bed1,
        bedNumber: "A",
      },
    });
    // Only a building: room and bed are empty.
    expect(page.items[2].place).toMatchObject({ roomId: null, roomNumber: null, bedId: null, floorNumber: null });
  });

  it("never includes phone numbers in the list", async () => {
    const page = await listStudents(db, filters({ buildingId: a.building }));
    expect(JSON.stringify(page)).not.toContain("9876543210");
  });

  it("searches name, email and room number, ignoring case", async () => {
    expect(await names({ search: "ASHA", buildingId: a.building })).toEqual(["Asha Rao"]);
    expect(await names({ search: `bina.shah-${tag}`, buildingId: a.building })).toEqual(["bina Shah"]);
    expect(await names({ search: "101", buildingId: a.building })).toEqual(["Asha Rao", "bina Shah"]);
  });

  it("treats % and _ in the search as plain characters", async () => {
    expect(await names({ search: "50%_", buildingId: a.building })).toEqual(["Chetan 50%_Off"]);
    expect(await names({ search: "%", buildingId: a.building })).toEqual(["Chetan 50%_Off"]);
    expect(await names({ search: "_", buildingId: a.building })).toEqual(["Chetan 50%_Off"]);
  });

  it("filters by floor, room and category", async () => {
    expect(await names({ floorId: a.floor })).toEqual(["Asha Rao", "bina Shah"]);
    expect(await names({ roomId: b.room })).toEqual(["Deepa Iyer"]);
    expect(await names({ buildingId: a.building, category: "working" })).toEqual(["bina Shah"]);
  });

  it("shows former students only when asked, without a current place", async () => {
    const former = await listStudents(db, filters({ active: false, search: `esha.former-${tag}` }));
    expect(former.items).toHaveLength(1);
    expect(former.items[0]).toMatchObject({ name: "Esha Former", isActive: false, place: null });

    const everyone = await listStudents(db, filters({ active: null, search: tag }));
    expect(everyone.total).toBe(5);
  });

  it("pages through the results, with the total of all pages", async () => {
    const first = await listStudents(db, filters({ buildingId: a.building, limit: 2, page: 1 }));
    const second = await listStudents(db, filters({ buildingId: a.building, limit: 2, page: 2 }));
    const beyond = await listStudents(db, filters({ buildingId: a.building, limit: 2, page: 9 }));
    expect(first.items.map((s) => s.name)).toEqual(["Asha Rao", "bina Shah"]);
    expect(second.items.map((s) => s.name)).toEqual(["Chetan 50%_Off"]);
    expect(beyond).toEqual({ items: [], total: 3 });
    expect(first.total).toBe(3);
  });

  it("never lists the owner", async () => {
    const page = await listStudents(db, filters({ active: null, limit: 50, search: "Test Owner" }));
    expect(page.items).toEqual([]);
  });
});

describe("getStudent", () => {
  it("returns the full profile with the current stay, the history and the next due date", async () => {
    const id = ids["Asha Rao"];
    // An earlier stay in building B, ended before the current one began.
    await db.query(
      `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by)
       VALUES ($1, $2, '2025-08-01', '2026-01-30', $3)`,
      [id, b.building, owner],
    );

    const profile = await getStudent(db, id, TODAY);

    expect(profile).toMatchObject({
      id,
      name: "Asha Rao",
      email: `asha.rao-${tag}@test.local`,
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
      isActive: true,
      deactivatedAt: null,
      mustChangePassword: true,
      // Joined on the 31st: November has 30 days.
      nextDueDate: "2026-11-30",
    });
    expect(profile.currentStay).toEqual({
      id: expect.any(Number),
      buildingId: a.building,
      buildingName: a.buildingName,
      floorNumber: 1,
      roomId: a.room,
      roomNumber: "101",
      bedId: a.bed1,
      bedNumber: "A",
      startedOn: "2026-01-31",
      endedOn: null,
    });
    // Newest first; the current stay is in the history too.
    expect(profile.stays.map((s) => [s.buildingId, s.startedOn, s.endedOn])).toEqual([
      [a.building, "2026-01-31", null],
      [b.building, "2025-08-01", "2026-01-30"],
    ]);
    // Never the password hash.
    expect(JSON.stringify(profile)).not.toMatch(/password_hash|\$2[ab]\$/);
  });

  it("shows a former student with no current stay and no next due date", async () => {
    const profile = await getStudent(db, ids["Esha Former"], TODAY);
    expect(profile).toMatchObject({ isActive: false, currentStay: null, nextDueDate: null });
    expect(profile.deactivatedAt).not.toBeNull();
    expect(profile.stays).toHaveLength(1);
    expect(profile.stays[0].endedOn).toBe("2026-06-30");
  });

  it("answers 404 for an unknown id and for the owner's own id", async () => {
    for (const id of [999_999_999, owner]) {
      const err = await getStudent(db, id, TODAY).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 404, code: "student_not_found" });
    }
  });
});

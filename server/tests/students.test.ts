import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { verifyPassword } from "../src/lib/password";
import { TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LENGTH } from "../src/lib/tempPassword";
import { admitStudent, type AdmissionInput } from "../src/services/students";
import { insertOwner, insertStay, insertStructure, testPool } from "./helpers/db";

// admitStudent in src/services/students.ts (you write it). It runs its own transaction,
// so these tests use the pool and their rows stay; every test makes its own building
// and email, and the whole test database is recreated on the next run.
// Each admission hashes a password at cost 12, hence the longer timeout.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;

function input(overrides: Partial<AdmissionInput> & { buildingId: number }): AdmissionInput {
  return {
    name: "Asha Rao",
    email: `asha-${randomUUID()}@test.local`,
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
    roomId: null,
    bedId: null,
    ...overrides,
  };
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected the admission to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

async function accountsWithEmail(email: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  return rows[0].n;
}

describe("admitStudent", { timeout: 30_000 }, () => {
  it("creates the student with a temporary password and a current stay in the building", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const data = input({ buildingId: s.building });

    const { student, temporaryPassword } = await admitStudent(db, owner, data);

    expect(student).toEqual({
      id: expect.any(Number),
      name: "Asha Rao",
      email: data.email,
      joiningDate: "2026-01-31",
      buildingId: s.building,
      roomId: null,
      bedId: null,
    });

    // The temporary password: 10 readable characters.
    expect(temporaryPassword).toHaveLength(TEMP_PASSWORD_LENGTH);
    for (const ch of temporaryPassword) expect(TEMP_PASSWORD_ALPHABET).toContain(ch);

    const { rows: users } = await db.query("SELECT * FROM users WHERE id = $1", [student.id]);
    const u = users[0];
    expect(u).toMatchObject({
      role: "student",
      name: "Asha Rao",
      email: data.email,
      phone: "9876543210",
      parent_phone: "9876500000",
      category: "college",
      college_name: "City College",
      branch: "CSE",
      academic_year: 2,
      company: null,
      designation: null,
      joining_date: "2026-01-31",
      food_preference: "veg",
      monthly_fee: 6500,
      is_active: true,
      must_change_password: true,
    });
    // Only the hash is stored, and it matches the password that was handed back.
    expect(u.password_hash).not.toContain(temporaryPassword);
    expect(await verifyPassword(temporaryPassword, u.password_hash)).toBe(true);

    const { rows: stays } = await db.query("SELECT * FROM stays WHERE student_id = $1", [student.id]);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({
      building_id: s.building,
      room_id: null,
      bed_id: null,
      started_on: "2026-01-31", // the joining date
      ended_on: null,
      created_by: owner,
    });
  });

  it("gives every student a different temporary password", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const a = await admitStudent(db, owner, input({ buildingId: s.building }));
    const b = await admitStudent(db, owner, input({ buildingId: s.building }));
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
  });

  it("stores a non-veg student's veg days", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const { student } = await admitStudent(
      db,
      owner,
      input({ buildingId: s.building, foodPreference: "non_veg", vegDays: [2, 6] }),
    );
    const { rows } = await db.query("SELECT food_preference, veg_days FROM users WHERE id = $1", [
      student.id,
    ]);
    expect(rows[0]).toEqual({ food_preference: "non_veg", veg_days: [2, 6] });
  });

  it("stores a working professional's company and optional designation", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const { student } = await admitStudent(
      db,
      owner,
      input({
        buildingId: s.building,
        category: "working",
        collegeName: null,
        branch: null,
        academicYear: null,
        company: "Acme Pvt Ltd",
        designation: null,
        foodPreference: "non_veg",
        monthlyFee: null,
      }),
    );
    const { rows } = await db.query(
      "SELECT category, company, designation, college_name, food_preference, monthly_fee FROM users WHERE id = $1",
      [student.id],
    );
    expect(rows[0]).toEqual({
      category: "working",
      company: "Acme Pvt Ltd",
      designation: null,
      college_name: null,
      food_preference: "non_veg",
      monthly_fee: null,
    });
  });

  it("places the student in a room, or in a bed, when given", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);

    const inRoom = await admitStudent(db, owner, input({ buildingId: s.building, roomId: s.room }));
    expect(inRoom.student).toMatchObject({ roomId: s.room, bedId: null });

    const inBed = await admitStudent(
      db,
      owner,
      input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 }),
    );
    expect(inBed.student).toMatchObject({ roomId: s.room, bedId: s.bed1 });
    const { rows } = await db.query(
      "SELECT room_id, bed_id FROM stays WHERE student_id = $1 AND ended_on IS NULL",
      [inBed.student.id],
    );
    expect(rows[0]).toEqual({ room_id: s.room, bed_id: s.bed1 });
  });

  it("refuses an unknown building, a room from another building and a bed from another room", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const other = await insertStructure(db);

    await expectRefused(admitStudent(db, owner, input({ buildingId: MISSING })), 404, "building_not_found");
    await expectRefused(
      admitStudent(db, owner, input({ buildingId: s.building, roomId: MISSING })),
      404,
      "room_not_found",
    );
    await expectRefused(
      admitStudent(db, owner, input({ buildingId: s.building, roomId: other.room })),
      404,
      "room_not_found",
    );
    await expectRefused(
      admitStudent(db, owner, input({ buildingId: s.building, roomId: s.room, bedId: MISSING })),
      404,
      "bed_not_found",
    );
    await expectRefused(
      admitStudent(db, owner, input({ buildingId: s.building, roomId: s.room, bedId: other.bed1 })),
      404,
      "bed_not_found",
    );
  });

  it("refuses a retired bed", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    await db.query("UPDATE beds SET is_active = false WHERE id = $1", [s.bed1]);
    const data = input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 });

    await expectRefused(admitStudent(db, owner, data), 409, "bed_retired");
    expect(await accountsWithEmail(data.email)).toBe(0);
  });

  it("refuses an occupied bed and leaves no account behind", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    await insertStay(db, { building: s.building, room: s.room, bed: s.bed1 });
    const data = input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 });

    await expectRefused(admitStudent(db, owner, data), 409, "bed_occupied");
    // The user insert ran before the stay was refused; the rollback must undo it.
    expect(await accountsWithEmail(data.email)).toBe(0);
  });

  it("accepts a bed whose previous student has moved out", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    await insertStay(db, { building: s.building, room: s.room, bed: s.bed1, endedOn: "2026-06-30" });
    const { student } = await admitStudent(
      db,
      owner,
      input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 }),
    );
    expect(student.bedId).toBe(s.bed1);
  });

  it("lets only one of two simultaneous admissions take the same bed", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const bed = { buildingId: s.building, roomId: s.room, bedId: s.bed2 };
    const a = input(bed);
    const b = input(bed);

    const results = await Promise.allSettled([admitStudent(db, owner, a), admitStudent(db, owner, b)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: "bed_occupied" });
    // Exactly one of the two accounts exists.
    expect((await accountsWithEmail(a.email)) + (await accountsWithEmail(b.email))).toBe(1);
  });

  it("refuses an email that already belongs to an account, in any letter case", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const taken = `Taken-${randomUUID()}@Test.Local`;
    await db.query(
      `INSERT INTO users (role, name, email, password_hash) VALUES ('owner', 'Someone', $1, 'x')`,
      [taken],
    );
    const data = input({ buildingId: s.building, email: taken.toLowerCase() });

    await expectRefused(admitStudent(db, owner, data), 409, "email_taken");
    expect(await accountsWithEmail(taken)).toBe(1);
  });

  it("writes a message for the owner on every refusal", async () => {
    const owner = await insertOwner(db);
    const err = await admitStudent(db, owner, input({ buildingId: MISSING })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message.length).toBeGreaterThan(10);
  });
});

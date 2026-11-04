import { afterAll, describe, expect, it } from "vitest";
import { addDays, hostelToday } from "../src/lib/dates";
import { HttpError } from "../src/lib/http";
import { verifyPassword } from "../src/lib/password";
import { TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LENGTH } from "../src/lib/tempPassword";
import { deactivateStudent, reactivateStudent, type ReactivationInput } from "../src/services/students";
import { insertOwner, insertStay, insertStructure, insertStudent, testPool } from "./helpers/db";

// reactivateStudent in src/services/students.ts (you write it). It runs its own
// transaction, so these tests use the pool and every test makes its own rows.
// Each reactivation hashes a password at cost 12, hence the longer timeout.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const LEFT_ON = "2026-06-30";

// A former student: moved out on LEFT_ON from a stay at `at`, written straight to the tables.
async function formerStudent(at: { building: number; room?: number; bed?: number }) {
  const owner = await insertOwner(db);
  const student = await insertStudent(db, { isActive: false });
  await db.query("UPDATE users SET deactivated_at = $1 WHERE id = $2", [`${LEFT_ON}T10:00:00+05:30`, student]);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, ended_on, created_by)
     VALUES ($1, $2, $3, $4, '2026-01-14', $5, $6) RETURNING id`,
    [student, at.building, at.room ?? null, at.bed ?? null, LEFT_ON, owner],
  );
  return { owner, student, stay: rows[0].id };
}

const input = (overrides: Partial<ReactivationInput> & { buildingId: number }): ReactivationInput => ({
  joiningDate: "2026-11-04",
  roomId: null,
  bedId: null,
  ...overrides,
});

async function userRow(id: number) {
  const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}

async function staysOf(student: number) {
  const { rows } = await db.query(
    `SELECT id, building_id, room_id, bed_id, started_on, ended_on, created_by
     FROM stays WHERE student_id = $1 ORDER BY id`,
    [student],
  );
  return rows;
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected the reactivation to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

describe("reactivateStudent", { timeout: 30_000 }, () => {
  it("reactivates with a new joining date, a new temporary password and a new stay", async () => {
    const s = await insertStructure(db);
    const other = await insertStructure(db);
    const { owner, student, stay } = await formerStudent({ building: s.building, room: s.room, bed: s.bed1 });
    const before = await userRow(student);

    const { student: back, temporaryPassword } = await reactivateStudent(
      db,
      owner,
      student,
      input({ buildingId: other.building, roomId: other.room, bedId: other.bed2 }),
    );

    expect(back).toEqual({
      id: student,
      name: before.name,
      email: before.email,
      joiningDate: "2026-11-04",
      buildingId: other.building,
      roomId: other.room,
      bedId: other.bed2,
    });
    expect(temporaryPassword).toHaveLength(TEMP_PASSWORD_LENGTH);
    for (const ch of temporaryPassword) expect(TEMP_PASSWORD_ALPHABET).toContain(ch);

    const after = await userRow(student);
    expect(after).toMatchObject({
      is_active: true,
      deactivated_at: null,
      joining_date: "2026-11-04",
      must_change_password: true,
    });
    // Only the new hash is stored, and the old password no longer matches it.
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_hash).not.toContain(temporaryPassword);
    expect(await verifyPassword(temporaryPassword, after.password_hash)).toBe(true);

    const rows = await staysOf(student);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: stay, ended_on: LEFT_ON }); // history untouched
    expect(rows[1]).toMatchObject({
      building_id: other.building,
      room_id: other.room,
      bed_id: other.bed2,
      started_on: "2026-11-04",
      ended_on: null,
      created_by: owner,
    });
  });

  it("keeps everything else about the student", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await formerStudent({ building: s.building });
    await db.query("UPDATE users SET monthly_fee = 6500, food_preference = 'non_veg', veg_days = '{2}' WHERE id = $1", [
      student,
    ]);
    const before = await userRow(student);

    await reactivateStudent(db, owner, student, input({ buildingId: s.building }));

    const after = await userRow(student);
    for (const column of [
      "role",
      "name",
      "email",
      "phone",
      "parent_phone",
      "category",
      "food_preference",
      "veg_days",
      "monthly_fee",
      "created_at",
    ]) {
      expect(after[column], column).toEqual(before[column]);
    }
  });

  it("gives a new password each time", async () => {
    const s = await insertStructure(db);
    const a = await formerStudent({ building: s.building });
    const b = await formerStudent({ building: s.building });
    const first = await reactivateStudent(db, a.owner, a.student, input({ buildingId: s.building }));
    const second = await reactivateStudent(db, b.owner, b.student, input({ buildingId: s.building }));
    expect(first.temporaryPassword).not.toBe(second.temporaryPassword);
  });

  it("accepts a joining date on the day the student left, and one in the future", async () => {
    const s = await insertStructure(db);
    const sameDay = await formerStudent({ building: s.building });
    const later = await formerStudent({ building: s.building });

    await reactivateStudent(db, sameDay.owner, sameDay.student, input({ buildingId: s.building, joiningDate: LEFT_ON }));
    await reactivateStudent(db, later.owner, later.student, input({ buildingId: s.building, joiningDate: "2099-12-01" }));

    expect((await staysOf(sameDay.student))[1]).toMatchObject({ started_on: LEFT_ON, ended_on: null });
    expect((await staysOf(later.student))[1]).toMatchObject({ started_on: "2099-12-01", ended_on: null });
  });

  it("refuses a joining date before the day the student left, and changes nothing", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await formerStudent({ building: s.building });
    const before = await userRow(student);

    await expectRefused(
      reactivateStudent(db, owner, student, input({ buildingId: s.building, joiningDate: "2026-06-29" })),
      409,
      "joining_before_leaving",
    );

    expect(await userRow(student)).toEqual(before);
    expect(await staysOf(student)).toHaveLength(1);
  });

  it("measures from the move-out day, so a booking cancelled before arrival does not block an earlier return", async () => {
    // Booked to join on FUTURE, moved out today before arriving: that stay ends on FUTURE.
    const s = await insertStructure(db);
    const owner = await insertOwner(db);
    const student = await insertStudent(db);
    await db.query(
      `INSERT INTO stays (student_id, building_id, started_on, created_by) VALUES ($1, $2, '2099-12-01', $3)`,
      [student, s.building, owner],
    );
    const movedOutOn = hostelToday();
    await deactivateStudent(db, student, movedOutOn);

    // Coming back before the cancelled start date is fine; before the move-out day is not.
    await expectRefused(
      reactivateStudent(db, owner, student, input({ buildingId: s.building, joiningDate: addDays(movedOutOn, -1) })),
      409,
      "joining_before_leaving",
    );
    const { student: back } = await reactivateStudent(
      db,
      owner,
      student,
      input({ buildingId: s.building, joiningDate: addDays(movedOutOn, 5) }),
    );
    expect(back.joiningDate).toBe(addDays(movedOutOn, 5));
    expect((await staysOf(student)).map((r) => [r.started_on, r.ended_on])).toEqual([
      ["2099-12-01", "2099-12-01"],
      [addDays(movedOutOn, 5), null],
    ]);
  });

  it("falls back to the latest end date when the move-out time is missing", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await formerStudent({ building: s.building });
    await db.query("UPDATE users SET deactivated_at = NULL WHERE id = $1", [student]);

    await expectRefused(
      reactivateStudent(db, owner, student, input({ buildingId: s.building, joiningDate: "2026-06-29" })),
      409,
      "joining_before_leaving",
    );
    await reactivateStudent(db, owner, student, input({ buildingId: s.building, joiningDate: LEFT_ON }));
  });

  it("refuses a student who is already current", async () => {
    const s = await insertStructure(db);
    const owner = await insertOwner(db);
    const student = await insertStudent(db);

    await expectRefused(reactivateStudent(db, owner, student, input({ buildingId: s.building })), 409, "student_active");
    expect((await userRow(student)).must_change_password).toBe(false);
  });

  it("refuses an unknown student, and an owner's id", async () => {
    const s = await insertStructure(db);
    const owner = await insertOwner(db);

    await expectRefused(reactivateStudent(db, owner, MISSING, input({ buildingId: s.building })), 404, "student_not_found");
    await expectRefused(reactivateStudent(db, owner, owner, input({ buildingId: s.building })), 404, "student_not_found");
  });

  it("refuses an unknown building, a room from another building, a bed from another room and a retired bed", async () => {
    const s = await insertStructure(db);
    const other = await insertStructure(db);
    await db.query("UPDATE beds SET is_active = false WHERE id = $1", [s.bed2]);
    const { owner, student } = await formerStudent({ building: s.building });
    const go = (place: Partial<ReactivationInput> & { buildingId: number }) =>
      reactivateStudent(db, owner, student, input(place));

    await expectRefused(go({ buildingId: MISSING }), 404, "building_not_found");
    await expectRefused(go({ buildingId: s.building, roomId: other.room }), 404, "room_not_found");
    await expectRefused(go({ buildingId: s.building, roomId: s.room, bedId: other.bed1 }), 404, "bed_not_found");
    await expectRefused(go({ buildingId: s.building, roomId: s.room, bedId: s.bed2 }), 409, "bed_retired");
    expect((await userRow(student)).is_active).toBe(false);
  });

  it("refuses an occupied bed and leaves the student moved out", async () => {
    const s = await insertStructure(db);
    await insertStay(db, { building: s.building, room: s.room, bed: s.bed1 });
    const { owner, student } = await formerStudent({ building: s.building });
    const before = await userRow(student);

    await expectRefused(
      reactivateStudent(db, owner, student, input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 })),
      409,
      "bed_occupied",
    );

    // The account update ran before the stay was refused; the rollback must undo it.
    expect(await userRow(student)).toEqual(before);
    expect(await staysOf(student)).toHaveLength(1);
  });

  it("lets only one of two former students take the same bed", async () => {
    const s = await insertStructure(db);
    const a = await formerStudent({ building: s.building });
    const b = await formerStudent({ building: s.building });
    const bed = input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 });

    const results = await Promise.allSettled([
      reactivateStudent(db, a.owner, a.student, bed),
      reactivateStudent(db, b.owner, b.student, bed),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: "bed_occupied" });
    const active = [(await userRow(a.student)).is_active, (await userRow(b.student)).is_active];
    expect(active.filter(Boolean)).toHaveLength(1);
  });

  it("lets only one of two simultaneous reactivations of the same student through", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await formerStudent({ building: s.building });

    const results = await Promise.allSettled([
      reactivateStudent(db, owner, student, input({ buildingId: s.building })),
      reactivateStudent(db, owner, student, input({ buildingId: s.building })),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected[0].reason).toMatchObject({ status: 409, code: "student_active" });
    expect((await staysOf(student)).filter((r) => r.ended_on === null)).toHaveLength(1);
  });

  it("writes a message for the owner on every refusal", async () => {
    const owner = await insertOwner(db);
    const err = await reactivateStudent(db, owner, MISSING, input({ buildingId: MISSING })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message.length).toBeGreaterThan(10);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { deactivateStudent, transferStudent } from "../src/services/students";
import { insertOwner, insertStructure, insertStudent, testPool } from "./helpers/db";

// deactivateStudent in src/services/students.ts (you write it). It runs its own
// transaction, so these tests use the pool and every test makes its own rows.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const TODAY = "2026-11-04";
// A joining date that has not come yet, today or on any day these tests run.
const FUTURE = "2099-12-01";

type Where = { building: number; room?: number; bed?: number };

// A current student living at `at` since `startedOn`, written straight to the tables.
async function placeStudent(at: Where, startedOn = "2026-01-14") {
  const owner = await insertOwner(db);
  const student = await insertStudent(db);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [student, at.building, at.room ?? null, at.bed ?? null, startedOn, owner],
  );
  return { owner, student, stay: rows[0].id };
}

async function userRow(id: number) {
  const { rows } = await db.query(
    `SELECT name, email, joining_date, password_hash, must_change_password, is_active, deactivated_at
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function staysOf(student: number) {
  const { rows } = await db.query(
    "SELECT id, bed_id, started_on, ended_on FROM stays WHERE student_id = $1 ORDER BY id",
    [student],
  );
  return rows;
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected the move-out to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

describe("deactivateStudent", () => {
  it("deactivates the account and ends the current stay today, keeping it as history", async () => {
    const s = await insertStructure(db);
    const { student, stay } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });
    const before = await userRow(student);

    await deactivateStudent(db, student, TODAY);

    const after = await userRow(student);
    expect(after.is_active).toBe(false);
    expect(after.deactivated_at).toBeInstanceOf(Date);
    expect(Date.now() - (after.deactivated_at as Date).getTime()).toBeLessThan(60_000);
    // Nothing else about the account changes.
    expect(after).toMatchObject({
      name: before.name,
      email: before.email,
      joining_date: before.joining_date,
      password_hash: before.password_hash,
      must_change_password: before.must_change_password,
    });
    expect(await staysOf(student)).toEqual([{ id: stay, bed_id: s.bed1, started_on: "2026-01-14", ended_on: TODAY }]);
  });

  it("frees the bed for someone else", async () => {
    const s = await insertStructure(db);
    const a = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });
    const b = await placeStudent({ building: s.building, room: s.room });

    await deactivateStudent(db, a.student, TODAY);
    const moved = await transferStudent(db, b.owner, b.student, { buildingId: s.building, roomId: s.room, bedId: s.bed1 }, TODAY);

    expect(moved.bedId).toBe(s.bed1);
  });

  it("ends a stay that has not started on its own start date", async () => {
    const s = await insertStructure(db);
    const { student } = await placeStudent({ building: s.building }, FUTURE);

    await deactivateStudent(db, student, TODAY);

    expect((await userRow(student)).is_active).toBe(false);
    expect(await staysOf(student)).toMatchObject([{ started_on: FUTURE, ended_on: FUTURE }]);
  });

  it("allows a move-out on the day the stay started", async () => {
    const s = await insertStructure(db);
    const { student } = await placeStudent({ building: s.building }, TODAY);

    await deactivateStudent(db, student, TODAY);

    expect(await staysOf(student)).toMatchObject([{ started_on: TODAY, ended_on: TODAY }]);
  });

  it("still deactivates a student who has no current stay", async () => {
    const student = await insertStudent(db);

    await deactivateStudent(db, student, TODAY);

    expect((await userRow(student)).is_active).toBe(false);
    expect(await staysOf(student)).toEqual([]);
  });

  it("refuses an unknown student, and an owner's id", async () => {
    const owner = await insertOwner(db);

    await expectRefused(deactivateStudent(db, MISSING, TODAY), 404, "student_not_found");
    await expectRefused(deactivateStudent(db, owner, TODAY), 404, "student_not_found");
    const { rows } = await db.query("SELECT is_active FROM users WHERE id = $1", [owner]);
    expect(rows[0].is_active).toBe(true);
  });

  it("refuses a student who has already moved out, and keeps the first move-out time", async () => {
    const s = await insertStructure(db);
    const { student } = await placeStudent({ building: s.building });
    await deactivateStudent(db, student, TODAY);
    const first = (await userRow(student)).deactivated_at;

    await expectRefused(deactivateStudent(db, student, TODAY), 409, "student_inactive");

    expect((await userRow(student)).deactivated_at).toEqual(first);
  });

  it("lets only one of two simultaneous move-outs through", async () => {
    const s = await insertStructure(db);
    const { student } = await placeStudent({ building: s.building });

    const results = await Promise.allSettled([
      deactivateStudent(db, student, TODAY),
      deactivateStudent(db, student, TODAY),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: "student_inactive" });
  });

  it("leaves a student moved out with no current stay when a move-out and a transfer race", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await placeStudent({ building: s.building });

    const results = await Promise.allSettled([
      deactivateStudent(db, student, TODAY),
      transferStudent(db, owner, student, { buildingId: s.building, roomId: s.room, bedId: s.bed1 }, TODAY),
    ]);

    // The move-out always wins in the end: either the transfer ran first and its new stay
    // was ended too, or the transfer found a former student and was refused cleanly.
    expect(results[0].status).toBe("fulfilled");
    if (results[1].status === "rejected") {
      expect(results[1].reason).toMatchObject({ status: 409, code: "student_inactive" });
    }
    expect((await userRow(student)).is_active).toBe(false);
    expect((await staysOf(student)).filter((r) => r.ended_on === null)).toEqual([]);
  });

  it("writes a message for the owner on every refusal", async () => {
    const err = await deactivateStudent(db, MISSING, TODAY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message.length).toBeGreaterThan(10);
  });
});

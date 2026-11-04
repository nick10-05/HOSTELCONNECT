import { afterAll, describe, expect, it } from "vitest";
import { addDays, hostelToday } from "../src/lib/dates";
import { HttpError } from "../src/lib/http";
import { transferStudent, type TransferInput } from "../src/services/students";
import { insertOwner, insertStay, insertStructure, insertStudent, testPool } from "./helpers/db";

// transferStudent in src/services/students.ts (you write it). Like admitStudent it runs
// its own transaction, so these tests use the pool and every test makes its own building
// and student.
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

const to = (buildingId: number, roomId: number | null = null, bedId: number | null = null): TransferInput => ({
  buildingId,
  roomId,
  bedId,
});

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
      throw new Error("expected the transfer to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

describe("transferStudent", () => {
  it("ends the current stay today and starts a new one today, keeping the old row", async () => {
    const s = await insertStructure(db);
    const other = await insertStructure(db);
    const { owner, student, stay } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });

    const moved = await transferStudent(db, owner, student, to(other.building, other.room, other.bed2), TODAY);

    expect(moved).toEqual({
      kind: "transferred",
      id: expect.any(Number),
      buildingId: other.building,
      roomId: other.room,
      bedId: other.bed2,
      startedOn: TODAY,
    });
    const rows = await staysOf(student);
    expect(rows).toHaveLength(2);
    // The old stay is untouched except for its end date.
    expect(rows[0]).toMatchObject({
      id: stay,
      building_id: s.building,
      room_id: s.room,
      bed_id: s.bed1,
      started_on: "2026-01-14",
      ended_on: TODAY,
    });
    expect(rows[1]).toMatchObject({
      id: moved.id,
      building_id: other.building,
      room_id: other.room,
      bed_id: other.bed2,
      started_on: TODAY,
      ended_on: null,
      created_by: owner,
    });
  });

  it("moves within the building: to another bed, to a room without a bed, or to the building only", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });

    await transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY);
    await transferStudent(db, owner, student, to(s.building, s.room), TODAY);
    await transferStudent(db, owner, student, to(s.building), TODAY);

    const rows = await staysOf(student);
    expect(rows.map((r) => [r.room_id, r.bed_id, r.ended_on])).toEqual([
      [s.room, s.bed1, TODAY],
      [s.room, s.bed2, TODAY],
      [s.room, null, TODAY],
      [null, null, null],
    ]);
  });

  it("frees the old bed for someone else", async () => {
    const s = await insertStructure(db);
    const a = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });
    const b = await placeStudent({ building: s.building, room: s.room });

    await transferStudent(db, a.owner, a.student, to(s.building, s.room, s.bed2), TODAY);
    const moved = await transferStudent(db, b.owner, b.student, to(s.building, s.room, s.bed1), TODAY);

    expect(moved.bedId).toBe(s.bed1);
  });

  it("allows a same-day transfer, so a wrong bed chosen at admission can be fixed", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 }, TODAY);

    const moved = await transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY);

    // A stay that starts today has started: this is a transfer, not a reassignment.
    expect(moved.kind).toBe("transferred");
    const rows = await staysOf(student);
    expect(rows[0]).toMatchObject({ started_on: TODAY, ended_on: TODAY });
    expect(rows[1]).toMatchObject({ bed_id: s.bed2, started_on: TODAY, ended_on: null });
  });

  it("refuses an occupied bed and leaves the current stay as it was", async () => {
    const s = await insertStructure(db);
    await insertStay(db, { building: s.building, room: s.room, bed: s.bed2 });
    const { owner, student, stay } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });

    await expectRefused(
      transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY),
      409,
      "bed_occupied",
    );

    // The old stay was ended before the insert was refused; the rollback must undo it.
    const rows = await staysOf(student);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: stay, bed_id: s.bed1, ended_on: null });
  });

  it("refuses a retired bed", async () => {
    const s = await insertStructure(db);
    await db.query("UPDATE beds SET is_active = false WHERE id = $1", [s.bed2]);
    const { owner, student } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });

    await expectRefused(
      transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY),
      409,
      "bed_retired",
    );
    expect(await staysOf(student)).toHaveLength(1);
  });

  it("refuses an unknown building, a room from another building and a bed from another room", async () => {
    const s = await insertStructure(db);
    const other = await insertStructure(db);
    const { owner, student } = await placeStudent({ building: s.building });

    await expectRefused(transferStudent(db, owner, student, to(MISSING), TODAY), 404, "building_not_found");
    await expectRefused(
      transferStudent(db, owner, student, to(s.building, MISSING), TODAY),
      404,
      "room_not_found",
    );
    await expectRefused(
      transferStudent(db, owner, student, to(s.building, other.room), TODAY),
      404,
      "room_not_found",
    );
    await expectRefused(
      transferStudent(db, owner, student, to(s.building, s.room, MISSING), TODAY),
      404,
      "bed_not_found",
    );
    await expectRefused(
      transferStudent(db, owner, student, to(s.building, s.room, other.bed1), TODAY),
      404,
      "bed_not_found",
    );
    expect(await staysOf(student)).toHaveLength(1);
  });

  it("refuses a move to exactly where the student already is", async () => {
    const s = await insertStructure(db);
    const inBed = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 });
    const inRoom = await placeStudent({ building: s.building, room: s.room });
    const inBuilding = await placeStudent({ building: s.building });

    await expectRefused(
      transferStudent(db, inBed.owner, inBed.student, to(s.building, s.room, s.bed1), TODAY),
      409,
      "same_place",
    );
    await expectRefused(
      transferStudent(db, inRoom.owner, inRoom.student, to(s.building, s.room), TODAY),
      409,
      "same_place",
    );
    await expectRefused(
      transferStudent(db, inBuilding.owner, inBuilding.student, to(s.building), TODAY),
      409,
      "same_place",
    );
    for (const p of [inBed, inRoom, inBuilding]) expect(await staysOf(p.student)).toHaveLength(1);
  });

  it("refuses an unknown student, and an owner's id", async () => {
    const s = await insertStructure(db);
    const owner = await insertOwner(db);

    await expectRefused(transferStudent(db, owner, MISSING, to(s.building), TODAY), 404, "student_not_found");
    await expectRefused(transferStudent(db, owner, owner, to(s.building), TODAY), 404, "student_not_found");
  });

  it("refuses a student who has moved out", async () => {
    const s = await insertStructure(db);
    const owner = await insertOwner(db);
    const student = await insertStudent(db, { isActive: false });

    await expectRefused(transferStudent(db, owner, student, to(s.building), TODAY), 409, "student_inactive");
    expect(await staysOf(student)).toHaveLength(0);
  });

  it("refuses an active student who has no current stay", async () => {
    const s = await insertStructure(db);
    const owner = await insertOwner(db);
    const student = await insertStudent(db);

    await expectRefused(transferStudent(db, owner, student, to(s.building), TODAY), 409, "no_current_stay");
    expect(await staysOf(student)).toHaveLength(0);
  });

  it("lets only one of two students racing for the same bed take it", async () => {
    const s = await insertStructure(db);
    const a = await placeStudent({ building: s.building });
    const b = await placeStudent({ building: s.building });
    const bed = to(s.building, s.room, s.bed1);

    const results = await Promise.allSettled([
      transferStudent(db, a.owner, a.student, bed, TODAY),
      transferStudent(db, b.owner, b.student, bed, TODAY),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: "bed_occupied" });
    // The loser still lives where it lived before.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stays
       WHERE student_id = ANY($1) AND ended_on IS NULL AND bed_id IS NULL`,
      [[a.student, b.student]],
    );
    expect(rows[0].n).toBe(1);
  });

  it("leaves one student with exactly one current stay when two transfers of them race", async () => {
    const s = await insertStructure(db);
    const { owner, student } = await placeStudent({ building: s.building });

    const results = await Promise.allSettled([
      transferStudent(db, owner, student, to(s.building, s.room, s.bed1), TODAY),
      transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY),
    ]);

    // Whatever your locking decides, at least one wins, a loser is a clean 409 (never a
    // raw database error, which would be a 500), and the student lives in one place.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(HttpError);
        expect(r.reason).toMatchObject({ status: 409 });
      }
    }
    const current = (await staysOf(student)).filter((r) => r.ended_on === null);
    expect(current).toHaveLength(1);
  });

  // A future joining date: the stay has not started, so it is moved in place.
  // FUTURE is after TODAY and after the real date, which migration 007's trigger checks.
  describe("a stay that has not started", () => {
    it("is reassigned in place: same row, same start, new place, no history", async () => {
      const s = await insertStructure(db);
      const other = await insertStructure(db);
      const { owner, student, stay } = await placeStudent(
        { building: s.building, room: s.room, bed: s.bed1 },
        FUTURE,
      );

      const moved = await transferStudent(db, owner, student, to(other.building, other.room, other.bed2), TODAY);

      expect(moved).toEqual({
        kind: "reassigned",
        id: stay,
        buildingId: other.building,
        roomId: other.room,
        bedId: other.bed2,
        startedOn: FUTURE,
      });
      const rows = await staysOf(student);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: stay,
        building_id: other.building,
        room_id: other.room,
        bed_id: other.bed2,
        started_on: FUTURE,
        ended_on: null,
      });
    });

    it("frees the old bed for someone else", async () => {
      const s = await insertStructure(db);
      const a = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 }, FUTURE);
      const b = await placeStudent({ building: s.building, room: s.room });

      await transferStudent(db, a.owner, a.student, to(s.building, s.room, s.bed2), TODAY);
      const moved = await transferStudent(db, b.owner, b.student, to(s.building, s.room, s.bed1), TODAY);

      expect(moved.bedId).toBe(s.bed1);
    });

    it("refuses an occupied bed and leaves the stay as it was", async () => {
      const s = await insertStructure(db);
      await insertStay(db, { building: s.building, room: s.room, bed: s.bed2 });
      const { owner, student, stay } = await placeStudent(
        { building: s.building, room: s.room, bed: s.bed1 },
        FUTURE,
      );

      await expectRefused(
        transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY),
        409,
        "bed_occupied",
      );
      const rows = await staysOf(student);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: stay, bed_id: s.bed1, ended_on: null });
    });

    it("refuses a retired bed", async () => {
      const s = await insertStructure(db);
      await db.query("UPDATE beds SET is_active = false WHERE id = $1", [s.bed2]);
      const { owner, student, stay } = await placeStudent(
        { building: s.building, room: s.room, bed: s.bed1 },
        FUTURE,
      );

      await expectRefused(
        transferStudent(db, owner, student, to(s.building, s.room, s.bed2), TODAY),
        409,
        "bed_retired",
      );
      expect((await staysOf(student))[0]).toMatchObject({ id: stay, bed_id: s.bed1 });
    });

    it("answers 409 stay_started when the stay started before the transaction ran", async () => {
      // The midnight case: the route computed `today` as yesterday, but by the database's
      // clock the stay has started, so migration 007's trigger refuses the reassignment.
      const s = await insertStructure(db);
      const realToday = hostelToday();
      const { owner, student, stay } = await placeStudent(
        { building: s.building, room: s.room, bed: s.bed1 },
        realToday,
      );

      await expectRefused(
        transferStudent(db, owner, student, to(s.building, s.room, s.bed2), addDays(realToday, -1)),
        409,
        "stay_started",
      );
      const rows = await staysOf(student);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: stay, bed_id: s.bed1, ended_on: null });
    });

    it("refuses a move to exactly where the student already is", async () => {
      const s = await insertStructure(db);
      const { owner, student } = await placeStudent({ building: s.building, room: s.room, bed: s.bed1 }, FUTURE);

      await expectRefused(
        transferStudent(db, owner, student, to(s.building, s.room, s.bed1), TODAY),
        409,
        "same_place",
      );
    });
  });

  it("writes a message for the owner on every refusal", async () => {
    const owner = await insertOwner(db);
    const err = await transferStudent(db, owner, MISSING, to(MISSING), TODAY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message.length).toBeGreaterThan(10);
  });
});

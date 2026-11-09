import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { hostelToday } from "../src/lib/dates";
import { admitStudent, getStudent, updateStudent, type StudentEdit } from "../src/services/students";
import { inRollback, insertOwner, insertStructure, insertStudent, pgError, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// Phase 5b: students under 18. The owner confirms a parent's or guardian's consent before
// adding one (decided in phase 0); the app records which owner confirmed it and when
// (migration 022). The route's checks are in tests/studentsRoutes.test.ts.
const db = testPool();
afterAll(() => db.end());

const consentOf = async (c: Pick<PoolClient, "query">, id: number) =>
  (
    await c.query<{ under_18: boolean; guardian_consent_at: Date | null; guardian_consent_by: string | null }>(
      "SELECT under_18, guardian_consent_at, guardian_consent_by FROM users WHERE id = $1",
      [id],
    )
  ).rows[0];

const edit = (overrides: Partial<StudentEdit> = {}): StudentEdit => ({
  name: "Asha Rao",
  email: `asha-${randomUUID()}@example.com`,
  phone: "9876543210",
  parentPhone: "9876500000",
  category: "college",
  collegeName: "City College",
  branch: "CSE",
  academicYear: 1,
  company: null,
  designation: null,
  foodPreference: "veg",
  vegDays: [],
  monthlyFee: 6500,
  ...overrides,
});

describe("migration 022: the database's rules", () => {
  it("marks nobody under 18 by default", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      expect(await consentOf(c, student)).toEqual({ under_18: false, guardian_consent_at: null, guardian_consent_by: null });
    }));

  it("refuses a student under 18 without a recorded consent", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const err = await pgError(c, "UPDATE users SET under_18 = true WHERE id = $1", [student]);
      expect(err.constraint).toBe("users_under_18_consent");
    }));

  it("refuses a consent time without the owner, or the owner without the time", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const noOwner = await pgError(c, "UPDATE users SET guardian_consent_at = now() WHERE id = $1", [student]);
      expect(noOwner.constraint).toBe("users_guardian_consent_both");
      const noTime = await pgError(c, "UPDATE users SET guardian_consent_by = $2 WHERE id = $1", [student, owner]);
      expect(noTime.constraint).toBe("users_guardian_consent_both");
    }));

  it("refuses to mark an owner under 18", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const err = await pgError(
        c,
        "UPDATE users SET under_18 = true, guardian_consent_at = now(), guardian_consent_by = $1 WHERE id = $1",
        [owner],
      );
      expect(err.constraint).toBe("users_under_18_students_only");
    }));

  it("refuses a consent recorded by an account of another hostel", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      // The other hostel's owner is made while marked for that hostel; then back to #1.
      const other = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Consent B') RETURNING id")).rows[0].id;
      await c.query("SELECT set_config('app.hostel_id', $1, true)", [String(other)]);
      const otherOwner = await insertOwner(c);
      await c.query("SELECT set_config('app.hostel_id', '1', true)");
      const err = await pgError(
        c,
        "UPDATE users SET under_18 = true, guardian_consent_at = now(), guardian_consent_by = $2 WHERE id = $1",
        [student, otherOwner],
      );
      expect(err.constraint).toBe("users_guardian_consent_by_fkey");
    }));
});

describe("admitting a student under 18", { timeout: 30_000 }, () => {
  it("records the consent with the owner who admitted them and the time", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const startedAt = (await db.query<{ now: Date }>("SELECT now()")).rows[0].now;
    const { student } = await admitStudent(db, owner, {
      ...edit(),
      joiningDate: "2026-01-31",
      under18: true,
      buildingId: s.building,
      roomId: null,
      bedId: null,
    });
    const row = await consentOf(db, student.id);
    expect(row.under_18).toBe(true);
    expect(Number(row.guardian_consent_by)).toBe(owner);
    expect(row.guardian_consent_at!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());

    const profile = await getStudent(db, student.id, hostelToday());
    expect(profile.under18).toBe(true);
    expect(profile.guardianConsent).toEqual({ on: hostelToday(), by: "Test Owner" });
  });

  it("records nothing for a student who is not under 18", async () => {
    const owner = await insertOwner(db);
    const s = await insertStructure(db);
    const { student } = await admitStudent(db, owner, {
      ...edit(),
      joiningDate: "2026-01-31",
      buildingId: s.building,
      roomId: null,
      bedId: null,
    });
    expect(await consentOf(db, student.id)).toEqual({ under_18: false, guardian_consent_at: null, guardian_consent_by: null });
    const profile = await getStudent(db, student.id, hostelToday());
    expect(profile).toMatchObject({ under18: false, guardianConsent: null });
  });
});

describe("editing whether a student is under 18", () => {
  it("records the consent the first time they are marked, and keeps it when they are unmarked", () =>
    inRollback(db, async (c) => {
      const first = await insertOwner(c);
      const second = await insertOwner(c);
      const student = await insertStudent(c);

      await updateStudent(rollbackDb(c), student, edit({ under18: true }), first);
      const marked = await consentOf(c, student);
      expect(marked.under_18).toBe(true);
      expect(Number(marked.guardian_consent_by)).toBe(first);

      // Saved again by another owner: the first confirmation stays.
      await updateStudent(rollbackDb(c), student, edit({ under18: true }), second);
      expect(await consentOf(c, student)).toEqual(marked);

      // They turned 18: unmarked, and the record of the consent is kept.
      await updateStudent(rollbackDb(c), student, edit({ under18: false }), second);
      expect(await consentOf(c, student)).toEqual({ ...marked, under_18: false });

      const profile = await getStudent(c, student, hostelToday());
      expect(profile.under18).toBe(false);
      expect(profile.guardianConsent).toEqual({ on: hostelToday(), by: "Test Owner" });
    }));

  it("leaves a student who was never under 18 without a consent", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      await updateStudent(rollbackDb(c), student, edit(), owner);
      expect(await consentOf(c, student)).toEqual({ under_18: false, guardian_consent_at: null, guardian_consent_by: null });
    }));
});

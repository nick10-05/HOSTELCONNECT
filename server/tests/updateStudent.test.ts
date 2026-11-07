import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { updateStudent, type StudentEdit } from "../src/services/students";
import { inRollback, insertOwner, insertStructure, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// updateStudent in src/services/students.ts (Nikhil writes it). It runs its own
// transaction; rollbackDb turns that into a savepoint inside each test's transaction, so
// nothing is left behind.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;

// A complete edit, as the route hands it over: a college student who eats veg on Tuesdays.
const edit = (overrides: Partial<StudentEdit> = {}): StudentEdit => ({
  name: "Asha Rao",
  email: `asha-${randomUUID()}@example.com`,
  phone: "9876543210",
  parentPhone: "9876500000",
  category: "college",
  collegeName: "City College",
  branch: "CSE",
  academicYear: 2,
  company: null,
  designation: null,
  foodPreference: "non_veg",
  vegDays: [2],
  monthlyFee: 6500,
  ...overrides,
});

async function userRow(c: PoolClient, id: number) {
  const { rows } = await c.query(
    `SELECT role, name, email, phone, parent_phone, category, college_name, branch,
            academic_year, company, designation, joining_date, food_preference, veg_days,
            monthly_fee, password_hash, must_change_password, is_active, deactivated_at
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const emailOf = async (c: PoolClient, id: number) =>
  (await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;

async function staysOf(c: PoolClient, student: number) {
  const { rows } = await c.query("SELECT * FROM stays WHERE student_id = $1 ORDER BY id", [student]);
  return rows;
}

async function feesOf(c: PoolClient, student: number) {
  const { rows } = await c.query("SELECT * FROM fees WHERE student_id = $1 ORDER BY id", [student]);
  return rows;
}

async function setFee(c: PoolClient, student: number, fee: number | null) {
  await c.query("UPDATE users SET monthly_fee = $1 WHERE id = $2", [fee, student]);
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected the edit to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

describe("updateStudent", () => {
  it("saves every detail, and nothing else about the account", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c, { mustChangePassword: true });
      const before = await userRow(c, student);
      const input = edit();

      await updateStudent(rollbackDb(c), student, input);

      expect(await userRow(c, student)).toEqual({
        ...before,
        name: "Asha Rao",
        email: input.email,
        phone: "9876543210",
        parent_phone: "9876500000",
        category: "college",
        college_name: "City College",
        branch: "CSE",
        academic_year: 2,
        company: null,
        designation: null,
        food_preference: "non_veg",
        veg_days: [2],
        monthly_fee: 6500,
      });
    });
  });

  it("clears the fields of the old category when the category changes", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);
      await updateStudent(rollbackDb(c), student, edit());

      await updateStudent(
        rollbackDb(c),
        student,
        edit({
          category: "working",
          collegeName: null,
          branch: null,
          academicYear: null,
          company: "Acme Ltd",
          designation: null,
          foodPreference: "veg",
          vegDays: [],
          monthlyFee: null,
        }),
      );

      expect(await userRow(c, student)).toMatchObject({
        category: "working",
        college_name: null,
        branch: null,
        academic_year: null,
        company: "Acme Ltd",
        designation: null,
        food_preference: "veg",
        veg_days: [],
        monthly_fee: null,
      });
    });
  });

  it("leaves the stays and the fee rows already created as they are", async () => {
    await inRollback(db, async (c) => {
      const s = await insertStructure(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      await setFee(c, student, 5000);
      await c.query(
        `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
         VALUES ($1, $2, $3, $4, '2026-01-14', $5)`,
        [student, s.building, s.room, s.bed1, owner],
      );
      await c.query(
        `INSERT INTO fees (student_id, due_date, amount, status, paid_on, recorded_by)
         VALUES ($1, '2026-02-14', 5000, 'paid', '2026-02-14', $2), ($1, '2026-03-14', 5000, 'pending', NULL, NULL)`,
        [student, owner],
      );
      const stays = await staysOf(c, student);
      const fees = await feesOf(c, student);

      await updateStudent(rollbackDb(c), student, edit({ monthlyFee: 6500 }));

      expect((await userRow(c, student)).monthly_fee).toBe(6500);
      expect(await staysOf(c, student)).toEqual(stays);
      expect(await feesOf(c, student)).toEqual(fees);
    });
  });

  it("accepts the student's own email again, in any letter case", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const own = await emailOf(c, student);

      await updateStudent(rollbackDb(c), student, edit({ email: own.toLowerCase() }));

      expect(await emailOf(c, student)).toBe(own.toLowerCase());
    });
  });

  it("refuses an email another account has, in any letter case (409 email_taken), and changes nothing", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      const owner = await insertOwner(c);
      const before = await userRow(c, student);

      for (const taken of [await emailOf(c, other), (await emailOf(c, owner)).toUpperCase()]) {
        await expectRefused(updateStudent(rollbackDb(c), student, edit({ email: taken })), 409, "email_taken");
      }

      expect(await userRow(c, student)).toEqual(before);
    });
  });

  it("corrects a former student's details when the fee stays the same", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c, { isActive: false });
      await setFee(c, student, 6500);

      await updateStudent(rollbackDb(c), student, edit({ name: "Asha R. Rao", monthlyFee: 6500 }));

      expect(await userRow(c, student)).toMatchObject({ name: "Asha R. Rao", monthly_fee: 6500, is_active: false });
    });
  });

  it("refuses to change a former student's fee (409 student_inactive), and changes nothing", async () => {
    await inRollback(db, async (c) => {
      for (const [stored, sent] of [
        [6500, 7000],
        [6500, null],
        [null, 6500],
      ] as const) {
        const student = await insertStudent(c, { isActive: false });
        await setFee(c, student, stored);
        const before = await userRow(c, student);

        await expectRefused(
          updateStudent(rollbackDb(c), student, edit({ name: "Someone Else", monthlyFee: sent })),
          409,
          "student_inactive",
        );

        expect(await userRow(c, student)).toEqual(before);
      }
    });
  });

  it("changes only that student", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      const owner = await insertOwner(c);
      const otherBefore = await userRow(c, other);
      const ownerBefore = await userRow(c, owner);

      await updateStudent(rollbackDb(c), student, edit());

      expect(await userRow(c, other)).toEqual(otherBefore);
      expect(await userRow(c, owner)).toEqual(ownerBefore);
    });
  });

  it("refuses an id no one has (404 student_not_found)", async () => {
    await inRollback(db, async (c) => {
      await expectRefused(updateStudent(rollbackDb(c), MISSING, edit()), 404, "student_not_found");
    });
  });

  it("refuses the owner's id as if it were missing, and changes nothing", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const before = await userRow(c, owner);

      await expectRefused(updateStudent(rollbackDb(c), owner, edit()), 404, "student_not_found");

      expect(await userRow(c, owner)).toEqual(before);
    });
  });
});

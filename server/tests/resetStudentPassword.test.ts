import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { HttpError } from "../src/lib/http";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LENGTH } from "../src/lib/tempPassword";
import { resetStudentPassword } from "../src/services/students";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// resetStudentPassword in src/services/students.ts (Nikhil writes it). One statement, so
// every test runs inside a transaction that is rolled back.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const OLD_PASSWORD = "old-password-1";
const TEMP_PASSWORD = new RegExp(`^[${TEMP_PASSWORD_ALPHABET}]{${TEMP_PASSWORD_LENGTH}}$`);

// Hashed once: bcrypt at cost 12 is slow.
const oldHash = hashPassword(OLD_PASSWORD);

async function userRow(c: PoolClient, id: number) {
  const { rows } = await c.query(
    `SELECT role, name, email, phone, joining_date, password_hash, must_change_password,
            is_active, deactivated_at
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected the reset to be refused, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

describe("resetStudentPassword", { timeout: 30_000 }, () => {
  it("gives the student a new temporary password that must be changed at the next login", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c, { passwordHash: await oldHash });
      const before = await userRow(c, student);

      const { temporaryPassword } = await resetStudentPassword(c, student);

      expect(temporaryPassword).toMatch(TEMP_PASSWORD);
      const after = await userRow(c, student);
      expect(await verifyPassword(temporaryPassword, after.password_hash)).toBe(true);
      expect(await verifyPassword(OLD_PASSWORD, after.password_hash)).toBe(false);
      expect(after.password_hash).not.toBe(temporaryPassword); // stored hashed, never plain
      expect(after.must_change_password).toBe(true);
      // Nothing else about the account changes.
      expect({ ...after, password_hash: undefined, must_change_password: undefined }).toEqual({
        ...before,
        password_hash: undefined,
        must_change_password: undefined,
      });
    });
  });

  it("also resets a student who has not changed their first temporary password yet", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c, { passwordHash: await oldHash, mustChangePassword: true });

      const { temporaryPassword } = await resetStudentPassword(c, student);

      const after = await userRow(c, student);
      expect(await verifyPassword(temporaryPassword, after.password_hash)).toBe(true);
      expect(await verifyPassword(OLD_PASSWORD, after.password_hash)).toBe(false);
      expect(after.must_change_password).toBe(true);
    });
  });

  it("gives a different password on every reset, and only the latest works", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);

      const first = await resetStudentPassword(c, student);
      const second = await resetStudentPassword(c, student);

      expect(second.temporaryPassword).not.toBe(first.temporaryPassword);
      const after = await userRow(c, student);
      expect(await verifyPassword(second.temporaryPassword, after.password_hash)).toBe(true);
      expect(await verifyPassword(first.temporaryPassword, after.password_hash)).toBe(false);
    });
  });

  it("changes only that student", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c, { passwordHash: await oldHash });
      const student = await insertStudent(c);
      const other = await insertStudent(c, { passwordHash: await oldHash });
      const ownerBefore = await userRow(c, owner);
      const otherBefore = await userRow(c, other);

      await resetStudentPassword(c, student);

      expect(await userRow(c, owner)).toEqual(ownerBefore);
      expect(await userRow(c, other)).toEqual(otherBefore);
    });
  });

  it("refuses an id no one has (404 student_not_found)", async () => {
    await inRollback(db, async (c) => {
      await expectRefused(resetStudentPassword(c, MISSING), 404, "student_not_found");
    });
  });

  it("refuses the owner's id as if it were missing, and changes nothing", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c, { passwordHash: await oldHash });
      const before = await userRow(c, owner);

      await expectRefused(resetStudentPassword(c, owner), 404, "student_not_found");

      expect(await userRow(c, owner)).toEqual(before);
    });
  });

  it("refuses a student who has moved out (409 student_inactive), and changes nothing", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c, { passwordHash: await oldHash, isActive: false });
      const before = await userRow(c, student);

      await expectRefused(resetStudentPassword(c, student), 409, "student_inactive");

      expect(await userRow(c, student)).toEqual(before);
    });
  });
});

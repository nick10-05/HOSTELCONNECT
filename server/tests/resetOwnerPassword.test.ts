import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  confirmationMatches,
  isLocalDatabase,
  resetOwnerPassword,
  resetTargetProblem,
} from "../scripts/resetOwnerPassword";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LENGTH } from "../src/lib/tempPassword";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// The owner password reset in scripts/resetOwnerPassword.ts. Each test runs in a
// transaction that is rolled back. Hashing at cost 12 is slow, hence the timeout.
const db = testPool();
afterAll(() => db.end());

const OLD_PASSWORD = "Owner-Old-Password-1";

async function userRow(c: PoolClient, id: number) {
  const { rows } = await c.query<{ email: string; password_hash: string; must_change_password: boolean }>(
    "SELECT email, password_hash, must_change_password FROM users WHERE id = $1",
    [id],
  );
  return rows[0];
}

describe("resetOwnerPassword", { timeout: 30_000 }, () => {
  it("gives the owner a new temporary password that must be changed at the next login", async () => {
    const oldHash = await hashPassword(OLD_PASSWORD);
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c, { passwordHash: oldHash, mustChangePassword: false });
      const { email } = await userRow(c, owner);

      const { temporaryPassword } = await resetOwnerPassword(c, email);

      expect(temporaryPassword).toHaveLength(TEMP_PASSWORD_LENGTH);
      for (const ch of temporaryPassword) expect(TEMP_PASSWORD_ALPHABET).toContain(ch);

      const after = await userRow(c, owner);
      expect(after.must_change_password).toBe(true);
      // Only a bcrypt hash is stored, at the project's cost.
      expect(after.password_hash).toMatch(/^\$2[ab]\$12\$/);
      expect(after.password_hash).not.toContain(temporaryPassword);
      expect(await verifyPassword(temporaryPassword, after.password_hash)).toBe(true);
      // The forgotten password no longer works.
      expect(await verifyPassword(OLD_PASSWORD, after.password_hash)).toBe(false);
    });
  });

  it("finds the owner whatever the letter case or spaces of the email", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const { email } = await userRow(c, owner);
      await resetOwnerPassword(c, `  ${email.toUpperCase()} `);
      expect((await userRow(c, owner)).must_change_password).toBe(true);
    });
  });

  it("gives a different password on every reset", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const { email } = await userRow(c, owner);
      const a = await resetOwnerPassword(c, email);
      const b = await resetOwnerPassword(c, email);
      expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
    });
  });

  it("refuses an email no account has, and changes nothing", async () => {
    await inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const before = await userRow(c, owner);
      await expect(resetOwnerPassword(c, "nobody@test.local")).rejects.toThrow(/no owner account/i);
      expect(await userRow(c, owner)).toEqual(before);
    });
  });

  it("refuses a student's email: it resets the owner only", async () => {
    await inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const before = await userRow(c, student);
      await expect(resetOwnerPassword(c, before.email)).rejects.toThrow(/no owner account/i);
      expect(await userRow(c, student)).toEqual(before);
    });
  });

  it("never names the email or the password in its refusal", async () => {
    await inRollback(db, async (c) => {
      const err = await resetOwnerPassword(c, "secret-person@test.local").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("secret-person");
    });
  });
});

describe("isLocalDatabase", () => {
  it("accepts a database on this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isLocalDatabase(`postgres://hostel_app:pw@${host}:5432/hostelconnect`)).toBe(true);
    }
  });

  it("refuses any other host, including Supabase's pooler", () => {
    for (const url of [
      "postgres://hostel_app.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      "postgres://u:pw@db.example.com:5432/x",
      // A name that only starts with "localhost" is someone else's machine.
      "postgres://u:pw@localhost.evil.example:5432/x",
    ]) {
      expect(isLocalDatabase(url)).toBe(false);
    }
  });

  it("refuses something that is not a URL at all", () => {
    expect(isLocalDatabase("")).toBe(false);
    expect(isLocalDatabase("not a url")).toBe(false);
  });
});

// Day 10: --production, for the owner's password in production (docs/RECOVERY.md).
describe("resetTargetProblem", () => {
  const LOCAL = "postgres://hostel_app:pw@localhost:5432/hostelconnect";
  const POOLER = "postgres://hostel_app.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";

  it("allows a local database without --production, and refuses any other", () => {
    expect(resetTargetProblem({ production: false, url: LOCAL })).toBeNull();
    expect(resetTargetProblem({ production: false, url: POOLER })).toBe(
      "DATABASE_URL points at a database on another machine. This script only resets the " +
        "local owner unless you add --production. Nothing was changed.",
    );
  });

  it("allows another machine's database with --production, and refuses a local one", () => {
    expect(resetTargetProblem({ production: true, url: POOLER })).toBeNull();
    for (const url of [LOCAL, "postgres://u:pw@127.0.0.1:5432/x", "postgres://u:pw@[::1]:5432/x"]) {
      expect(resetTargetProblem({ production: true, url })).toBe(
        "--production was given, but DATABASE_URL points at this machine. Set it to the " +
          "production database first (docs/RECOVERY.md). Nothing was changed.",
      );
    }
  });

  it("never names the host or repeats the URL", () => {
    for (const production of [true, false]) {
      for (const url of [LOCAL, POOLER]) {
        const problem = resetTargetProblem({ production, url }) ?? "";
        expect(problem).not.toContain("pooler.supabase.com");
        expect(problem).not.toContain("localhost");
        expect(problem).not.toContain(":pw@");
      }
    }
  });
});

describe("confirmationMatches", () => {
  const EMAIL = "Owner@Example.com";

  it("matches the same email, whatever its letter case or the spaces around it", () => {
    expect(confirmationMatches("Owner@Example.com", EMAIL)).toBe(true);
    expect(confirmationMatches("  owner@example.COM \r\n", EMAIL)).toBe(true);
  });

  it("refuses anything else, and an empty answer", () => {
    for (const typed of ["", "   ", "y", "yes", "owner@example.co", "owner@example.com.", "other@example.com"]) {
      expect(confirmationMatches(typed, EMAIL), JSON.stringify(typed)).toBe(false);
    }
  });
});

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { backupPassword, backupUrlProblem, forNodePg, setBackupLogin } from "../scripts/backupRole";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// scripts/backup-role.ts (multi-tenant phase 2d): the nightly backup's login.
const PASSWORD = "a".repeat(12) + "B".repeat(12);

describe("backupUrlProblem", () => {
  it("accepts hostel_backup's login, directly or through Supabase's pooler", () => {
    expect(backupUrlProblem(`postgres://hostel_backup:${PASSWORD}@localhost:5432/postgres`)).toBeNull();
    expect(
      backupUrlProblem(`postgresql://hostel_backup.abcdef:${PASSWORD}@pooler.example.com:5432/postgres?sslmode=require`),
    ).toBeNull();
  });

  it("refuses another role, above all the app's", () => {
    expect(backupUrlProblem(`postgres://hostel_app:${PASSWORD}@localhost:5432/postgres`)).toMatch(/hostel_backup/);
    expect(backupUrlProblem(`postgres://postgres.abcdef:${PASSWORD}@localhost:5432/postgres`)).toMatch(/hostel_backup/);
  });

  it("refuses a short password, a broken URL, and never quotes the URL", () => {
    expect(backupUrlProblem("postgres://hostel_backup:short-secret@localhost:5432/postgres")).toMatch(/at least 20/);
    const empty = backupUrlProblem("");
    expect(empty).toMatch(/BACKUP_DATABASE_URL is empty/);
    for (const message of [
      backupUrlProblem("postgres://hostel_backup:short-secret@db.example.com:5432/postgres"),
      backupUrlProblem(`postgres://someone:${PASSWORD}@db.example.com:5432/postgres`),
    ]) {
      expect(message).not.toMatch(/short-secret|someone|db\.example\.com|aaaa/);
    }
  });

  it("reads the password back, percent-decoded", () => {
    expect(backupPassword(`postgres://hostel_backup:${PASSWORD}%23x@localhost:5432/postgres`)).toBe(`${PASSWORD}#x`);
  });
});

describe("forNodePg", () => {
  it("connects Node with encryption but no CA check, as pg_dump's sslmode=require means", () => {
    expect(forNodePg(`postgres://hostel_backup.ref:${PASSWORD}@pooler.example.com:5432/postgres?sslmode=require`)).toBe(
      `postgres://hostel_backup.ref:${PASSWORD}@pooler.example.com:5432/postgres?sslmode=no-verify`,
    );
    const local = `postgres://hostel_backup:${PASSWORD}@localhost:5432/postgres`;
    expect(forNodePg(local)).toBe(local);
  });
});

describe("setBackupLogin", () => {
  // Roles belong to the whole server, so the change is checked inside a transaction that
  // is rolled back: setBackupLogin's own BEGIN and COMMIT become a savepoint's.
  it("lets hostel_backup log in, with the password given, and nothing more", async () => {
    const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
    await admin.connect();
    try {
      await admin.query("BEGIN");
      const inner = {
        query: (sql: string, params?: unknown[]) => {
          const s = sql.trim();
          if (s === "BEGIN") return admin.query("SAVEPOINT backup_login");
          if (s === "COMMIT") return admin.query("RELEASE SAVEPOINT backup_login");
          if (s === "ROLLBACK") return admin.query("ROLLBACK TO SAVEPOINT backup_login");
          return admin.query(sql, params);
        },
      } as unknown as Client;
      await setBackupLogin(inner, PASSWORD);
      const { rows } = await admin.query(
        `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreaterole,
                rolpassword LIKE 'SCRAM-SHA-256$%' AS hashed
         FROM pg_authid WHERE rolname = 'hostel_backup'`,
      );
      expect(rows).toEqual([{ rolcanlogin: true, rolbypassrls: false, rolsuper: false, rolcreaterole: false, hashed: true }]);
    } finally {
      await admin.query("ROLLBACK").catch(() => {});
      await admin.end();
    }
  });
});

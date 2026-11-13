import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  backupPassword,
  backupUrlFrom,
  backupUrlProblem,
  forNodePg,
  githubEnvLine,
  lockBackupLogin,
  maskCommand,
  newBackupPassword,
  setBackupLogin,
} from "../scripts/backupRole";
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

// scripts/backup-login.ts (2026-11-13): the backup workflow makes hostel_backup's login
// itself each night, with the migration credential it already has, and locks it again
// afterwards, so no BACKUP_DATABASE_URL secret has to be made by hand.
describe("the nightly backup login", () => {
  const POOLER = "postgres://postgres.abcdref:admin-pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=no-verify";

  it("builds hostel_backup's URL from the migration URL: same project, host, port and database", () => {
    const password = newBackupPassword();
    const url = new URL(backupUrlFrom(POOLER, password));
    expect(decodeURIComponent(url.username)).toBe("hostel_backup.abcdref");
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(url.hostname).toBe("aws-0-ap-south-1.pooler.supabase.com");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/postgres");
    // pg_dump reads require as "encrypt" (forNodePg turns it into no-verify for Node).
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.toString()).not.toContain("admin-pw");
    expect(backupUrlProblem(url.toString())).toBeNull();
  });

  it("logs in as plain hostel_backup when the migration URL has no project ref", () => {
    const url = new URL(backupUrlFrom("postgres://hostel_admin:pw@localhost:5432/hostelconnect", newBackupPassword()));
    expect(url.username).toBe("hostel_backup");
    expect(url.pathname).toBe("/hostelconnect");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("keeps a local server's sslmode=disable, and encrypts whatever else the migration URL says", () => {
    const local = new URL(backupUrlFrom("postgres://a:pw@localhost:5432/db?sslmode=disable", newBackupPassword()));
    expect(local.searchParams.get("sslmode")).toBe("disable");
    const prefer = new URL(backupUrlFrom("postgres://a:pw@db.example.com:5432/db?sslmode=prefer", newBackupPassword()));
    expect(prefer.searchParams.get("sslmode")).toBe("require");
  });

  it("refuses a broken migration URL without quoting it", () => {
    expect(() => backupUrlFrom("not a url secret-bit", newBackupPassword())).toThrow(/^MIGRATION_DATABASE_URL /);
    expect(() => backupUrlFrom("not a url secret-bit", newBackupPassword())).not.toThrow(/secret-bit/);
  });

  it("makes a new long random password each time, safe in a URL", () => {
    const a = newBackupPassword();
    const b = newBackupPassword();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it("hides the password and the URL in the workflow log, and hands the URL to the next steps", () => {
    expect(maskCommand("abc123")).toBe("::add-mask::abc123");
    expect(githubEnvLine("postgres://u:p@h:5432/db")).toBe("BACKUP_DATABASE_URL=postgres://u:p@h:5432/db\n");
    // A line break would let the value set a second variable.
    expect(() => githubEnvLine("postgres://u:p@h/db\nEVIL=1")).toThrow();
  });

  it("locks hostel_backup again after the backup: no login, no password", async () => {
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
      await lockBackupLogin(admin);
      const { rows } = await admin.query("SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = 'hostel_backup'");
      expect(rows).toEqual([{ rolcanlogin: false, rolpassword: null }]);
    } finally {
      await admin.query("ROLLBACK").catch(() => {});
      await admin.end();
    }
  });
});

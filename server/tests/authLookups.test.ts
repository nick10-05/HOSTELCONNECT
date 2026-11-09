import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { asHostel } from "./helpers/hostels";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Multi-tenant phase 2a (migration 014). From phase 2d, row-level security hides every
// row of users unless the request names its hostel. Signing in and checking a session
// come before the hostel is known, so they go through two narrow database functions that
// see past it and return only what those two steps need:
//
//   auth_user_by_id(user_id)            the session check (requireAuth): who is this,
//                                       which hostel, may they still get in
//   auth_user_by_email(hostel, email)   sign-in: the account for this email IN THIS
//                                       HOSTEL, with the password hash to compare
//
// Run as hostel_app, inside transactions that are rolled back.
const db = testPool();
afterAll(() => db.end());

type Queryable = Parameters<Parameters<typeof inRollback>[1]>[0];

async function newHostel(c: Queryable) {
  return (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Lookup Hostel') RETURNING id")).rows[0].id;
}

describe("auth_user_by_id", () => {
  it("returns the user's id, hostel, role, temporary-password flag and whether they may get in", () =>
    inRollback(db, async (c) => {
      const id = await insertStudent(c, { mustChangePassword: true });
      const { rows } = await c.query("SELECT * FROM auth_user_by_id($1)", [id]);
      expect(rows).toEqual([
        { id, hostel_id: 1, role: "student", must_change_password: true, is_active: true, hostel_active: true },
      ]);
    }));

  it("says so when the user has moved out", () =>
    inRollback(db, async (c) => {
      const id = await insertStudent(c, { isActive: false });
      const { rows } = await c.query("SELECT is_active, hostel_active FROM auth_user_by_id($1)", [id]);
      expect(rows).toEqual([{ is_active: false, hostel_active: true }]);
    }));

  it("finds users of every hostel, since the session names no hostel", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      await asHostel(c, other);
      const { rows: made } = await c.query<{ id: number }>(
        "INSERT INTO users (hostel_id, role, name, email, password_hash) VALUES ($1, 'owner', 'Other', 'lookup-other@test.local', 'x') RETURNING id",
        [other],
      );
      await asHostel(c, 1);
      const { rows } = await c.query("SELECT id, hostel_id FROM auth_user_by_id($1)", [made[0].id]);
      expect(rows).toEqual([{ id: made[0].id, hostel_id: other }]);
    }));

  it("returns nothing for an unknown id", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query("SELECT * FROM auth_user_by_id($1)", [999_999_999]);
      expect(rows).toEqual([]);
    }));

  it("never returns the password hash or contact details", () =>
    inRollback(db, async (c) => {
      const id = await insertOwner(c);
      const { fields } = await c.query("SELECT * FROM auth_user_by_id($1)", [id]);
      expect(fields.map((f) => f.name)).toEqual([
        "id",
        "hostel_id",
        "role",
        "must_change_password",
        "is_active",
        "hostel_active",
      ]);
    }));
});

describe("auth_user_by_email", () => {
  it("returns the account for the email in that hostel, with what sign-in needs", () =>
    inRollback(db, async (c) => {
      const id = await insertOwner(c, { passwordHash: "hash-for-lookup" });
      const { rows: u } = await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
      const { rows } = await c.query("SELECT * FROM auth_user_by_email(1, $1)", [u[0].email]);
      expect(rows).toEqual([
        {
          id,
          hostel_id: 1,
          name: "Test Owner",
          role: "owner",
          must_change_password: false,
          is_active: true,
          hostel_active: true,
          password_hash: "hash-for-lookup",
        },
      ]);
    }));

  it("ignores upper and lower case, as login always has", () =>
    inRollback(db, async (c) => {
      const id = await insertStudent(c);
      const { rows: u } = await c.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
      const { rows } = await c.query("SELECT id FROM auth_user_by_email(1, $1)", [u[0].email.toUpperCase()]);
      expect(rows).toEqual([{ id }]);
    }));

  it("never finds an account of another hostel", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      await asHostel(c, other);
      await c.query(
        "INSERT INTO users (hostel_id, role, name, email, password_hash) VALUES ($1, 'owner', 'Other', 'only-in-other@test.local', 'x')",
        [other],
      );
      await asHostel(c, 1);
      expect((await c.query("SELECT * FROM auth_user_by_email(1, 'only-in-other@test.local')")).rows).toEqual([]);
      expect((await c.query("SELECT id FROM auth_user_by_email($1, 'only-in-other@test.local')", [other])).rows).toHaveLength(1);
    }));

  it("returns nothing for an unknown email", () =>
    inRollback(db, async (c) => {
      expect((await c.query("SELECT * FROM auth_user_by_email(1, 'nobody-at-all@test.local')")).rows).toEqual([]);
    }));
});

describe("a suspended hostel", () => {
  // Only the platform admin suspends a hostel, so this test uses the admin credential on
  // the test database, inside a transaction that is rolled back.
  it("is reported by both lookups, so nobody of that hostel gets in", async () => {
    const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
    await admin.connect();
    try {
      await admin.query("BEGIN");
      const other = (await admin.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Suspended Hostel') RETURNING id"))
        .rows[0].id;
      const owner = (
        await admin.query<{ id: number }>(
          "INSERT INTO users (hostel_id, role, name, email, password_hash) VALUES ($1, 'owner', 'Other', 'suspended-owner@test.local', 'x') RETURNING id",
          [other],
        )
      ).rows[0].id;
      await admin.query("UPDATE hostels SET status = 'suspended' WHERE id = $1", [other]);
      expect((await admin.query("SELECT hostel_active FROM auth_user_by_id($1)", [owner])).rows).toEqual([
        { hostel_active: false },
      ]);
      expect(
        (await admin.query("SELECT hostel_active FROM auth_user_by_email($1, 'suspended-owner@test.local')", [other])).rows,
      ).toEqual([{ hostel_active: false }]);
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  });
});

describe("the functions themselves", () => {
  it("run with their owner's rights and a fixed search path, so nobody can slip in their own tables", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT proname, prosecdef, proconfig FROM pg_proc
         WHERE proname IN ('auth_user_by_id', 'auth_user_by_email') ORDER BY proname`,
      );
      expect(rows.map((r) => r.proname)).toEqual(["auth_user_by_email", "auth_user_by_id"]);
      for (const r of rows) {
        expect(r.prosecdef, r.proname).toBe(true);
        expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, public");
      }
    }));

  it("may be called by the app and by nobody else", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ proname: string; public_can: boolean; app_can: boolean }>(
        `SELECT proname,
                has_function_privilege('public', oid, 'EXECUTE') AS public_can,
                has_function_privilege('hostel_app', oid, 'EXECUTE') AS app_can
         FROM pg_proc WHERE proname IN ('auth_user_by_id', 'auth_user_by_email') ORDER BY proname`,
      );
      expect(rows).toEqual([
        { proname: "auth_user_by_email", public_can: false, app_can: true },
        { proname: "auth_user_by_id", public_can: false, app_can: true },
      ]);
    }));
});

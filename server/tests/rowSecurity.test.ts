import { Client, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { bareTestPool, inRollback, insertStudent, pgError, testPool } from "./helpers/db";
import { asHostel, fillHostelB } from "./helpers/hostels";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Multi-tenant phase 2d (migration 018): row-level security keeps each hostel's rows to
// that hostel in the database itself, whatever SQL the app sends. These tests send SQL
// with no hostel filter at all, as hostel_app, and see the database refuse or hide.
const db = testPool();
afterAll(() => db.end());

const PER_HOSTEL = [
  "announcements", "beds", "buildings", "complaint_events", "complaints", "fees", "floors", "hostel_settings",
  "notifications", "rejoin_requests", "return_poll_responses", "return_polls", "rooms", "stays", "users",
];
const INSUFFICIENT_PRIVILEGE = "42501";

// Rows of `table` with this id that a bare, unfiltered query sees.
const seen = async (c: PoolClient, table: string, id: number) =>
  (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount;

function asAdmin() {
  return new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
}

describe("row-level security", () => {
  it("is on for the 15 tables that belong to a hostel, with the app's and the backup's policies, not forced", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ table: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                array(SELECT p.policyname || ':' || array_to_string(p.roles, ',') || ':' || p.cmd
                      FROM pg_policies p WHERE p.tablename = c.relname ORDER BY 1) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         ORDER BY 1`,
      );
      expect(rows.map((r) => r.table)).toEqual(PER_HOSTEL);
      for (const r of rows) {
        expect(r, r.table).toMatchObject({
          forced: false,
          policies: ["backup_reads_all:hostel_backup:SELECT", "hostel_isolation:hostel_app:ALL"],
        });
      }
    }));

  it("hides every row of another hostel from unfiltered SQL, for reading, changing and deleting", () =>
    inRollback(db, async (c) => {
      const b = await fillHostelB(c);
      await asHostel(c, 1);
      // [table, id, a column the app may change]
      const theirs: [string, number, string][] = [
        ["users", b.student, "name"], ["buildings", b.building, "name"], ["floors", b.floor, "number"],
        ["rooms", b.room, "room_number"], ["beds", b.bed1, "is_active"], ["rejoin_requests", b.rejoin, "status"],
        ["notifications", b.notification, "read_at"], ["complaints", b.complaint, "priority"],
        ["announcements", b.announcement, "title"], ["return_polls", b.poll, "status"], ["fees", b.fee, "note"],
      ];
      // The tables the app may delete from (the others keep their history: no DELETE grant).
      const deletable = new Set(["buildings", "floors", "rooms", "notifications", "announcements"]);
      for (const [table, id, column] of theirs) {
        expect(await seen(c, table, id), table).toBe(0);
        expect((await c.query(`UPDATE ${table} SET ${column} = ${column} WHERE id = $1`, [id])).rowCount, table).toBe(0);
        if (deletable.has(table)) {
          expect((await c.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rowCount, table).toBe(0);
        }
      }
      expect((await c.query("SELECT 1 FROM stays WHERE student_id = $1", [b.student])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM complaint_events WHERE complaint_id = $1", [b.complaint])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM return_poll_responses WHERE poll_id = $1", [b.poll])).rowCount).toBe(0);
      // Seen again from inside hostel B: nothing was changed or deleted.
      await asHostel(c, b.hostel);
      for (const [table, id] of theirs) expect(await seen(c, table, id), table).toBe(1);
    }));

  it("refuses to write a row into another hostel, or to move one there", () =>
    inRollback(db, async (c) => {
      const b = await fillHostelB(c);
      await asHostel(c, 1);
      expect(
        await pgError(c, "INSERT INTO buildings (hostel_id, name) VALUES ($1, 'Smuggled Block')", [b.hostel]),
      ).toMatchObject({ code: INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/row-level security/) });
      expect(
        await pgError(
          c,
          "INSERT INTO notifications (hostel_id, user_id, type, title) VALUES ($1, $2, 'announcement', 'Hi')",
          [b.hostel, b.student],
        ),
      ).toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }));

  it("refuses every query on these tables outside withHostel", async () => {
    const bare = bareTestPool();
    try {
      for (const table of PER_HOSTEL) {
        await expect(bare.query(`SELECT count(*) FROM ${table}`), table).rejects.toThrow(/no hostel/i);
      }
      // Tables that belong to no hostel stay readable.
      await bare.query("SELECT count(*) FROM hostels");
      await bare.query("SELECT count(*) FROM usage_counters");
    } finally {
      await bare.end();
    }
  });

  it("still lets sign-in find any hostel's account (the lookups run as the tables' owner)", () =>
    inRollback(db, async (c) => {
      const b = await fillHostelB(c);
      await asHostel(c, 1);
      const { rows } = await c.query("SELECT id, hostel_id FROM auth_user_by_id($1)", [b.owner]);
      expect(rows).toEqual([{ id: b.owner, hostel_id: b.hostel }]);
    }));

  it("counts photo storage over every hostel, as the shared bucket's limit needs", () =>
    inRollback(db, async (c) => {
      const before = (await c.query<{ n: number }>("SELECT photo_storage_bytes() AS n")).rows[0].n;
      const b = await fillHostelB(c);
      await c.query(
        `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes, photo_expires_at)
         VALUES ($1, 'electrical', 'A photo in hostel B.', 'complaints/b.webp', 1000, now() + interval '1 day')`,
        [b.student],
      );
      await asHostel(c, 1);
      await c.query(
        `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes, photo_expires_at)
         VALUES ($1, 'plumbing', 'A photo in hostel 1.', 'complaints/one.webp', 300, now() + interval '1 day')`,
        [await insertStudent(c)],
      );
      expect((await c.query<{ n: number }>("SELECT photo_storage_bytes() AS n")).rows[0].n).toBe(before + 1300);
      // One snapshot for the whole test: photos other test files commit meanwhile don't count.
    }, { repeatableRead: true }));
});

// The nightly backup (.github/workflows/backup.yml) dumps as hostel_backup with
// --enable-row-security: it must see every hostel's rows and change none.
describe("hostel_backup", () => {
  it("reads every hostel's rows, and may not write", async () => {
    const admin = asAdmin();
    await admin.connect();
    try {
      await admin.query("BEGIN");
      // Two hostels' rows, made by the owner (which row-level security does not limit).
      const a = (await admin.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Backup A') RETURNING id")).rows[0].id;
      const b = (await admin.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Backup B') RETURNING id")).rows[0].id;
      for (const h of [a, b]) {
        await admin.query(
          "INSERT INTO buildings (hostel_id, name) VALUES ($1, $2)",
          [h, `Backup block ${h}`],
        );
      }
      await admin.query("SET LOCAL ROLE hostel_backup");
      await admin.query("SET LOCAL row_security = on");
      const { rows } = await admin.query<{ hostel_id: number }>(
        "SELECT hostel_id FROM buildings WHERE hostel_id IN ($1, $2) ORDER BY hostel_id",
        [a, b],
      );
      expect(rows.map((r) => r.hostel_id)).toEqual([a, b]);
      await admin.query("SAVEPOINT w");
      await expect(admin.query("INSERT INTO buildings (hostel_id, name) VALUES ($1, 'Nope')", [a])).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
      await admin.query("ROLLBACK TO SAVEPOINT w");
      await expect(admin.query("DELETE FROM buildings WHERE hostel_id = $1", [a])).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    } finally {
      await admin.query("ROLLBACK").catch(() => {});
      await admin.end();
    }
  });

  it("cannot log in until the operator gives it a password", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query("SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'hostel_backup'");
      expect(rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false }]);
    }));
});


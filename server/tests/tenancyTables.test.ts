import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStructure, insertStudent, pgError, testPool } from "./helpers/db";

// Multi-tenant SaaS, phase 1 (migration 013): the "expand" step. Every hostel's rows carry
// a hostel_id; today's single hostel is hostel #1, and every row the current code writes
// without a hostel lands there (DEFAULT 1), so the live app works unchanged. The database
// already makes it impossible for a row to point into another hostel or to change hostel.
// Run as hostel_app, the role the app uses, inside transactions that are rolled back.
const db = testPool();
afterAll(() => db.end());

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";

// Every table that belongs to one hostel. A new table must be added here (with its own
// hostel_id) or to NOT_PER_HOSTEL, so no table is forgotten when the hostels are isolated.
const PER_HOSTEL = [
  "announcements",
  "beds",
  "buildings",
  "complaint_events",
  "complaints",
  "fees",
  "floors",
  "hostel_settings",
  "notifications",
  "rejoin_requests",
  "return_poll_responses",
  "return_polls",
  "rooms",
  "stays",
  "users",
];
// hostels: the tenants themselves. schema_migrations: the migration runner's record.
// usage_counters: Supabase's limits are per project, so they stay platform-wide for now;
// per-hostel quotas come in phase 5.
const NOT_PER_HOSTEL = ["hostels", "schema_migrations", "usage_counters"];

async function newHostel(c: Parameters<Parameters<typeof inRollback>[1]>[0], name = "Second Hostel") {
  const { rows } = await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ($1) RETURNING id", [name]);
  return rows[0].id;
}

describe("hostels", () => {
  it("holds hostel #1 for today's data: HostelConnect, active, no slug yet, the beta limits", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query(
        `SELECT id, name, slug, status, student_limit, building_limit, fees_start_date
         FROM hostels WHERE id = 1`,
      );
      expect(rows).toEqual([
        {
          id: 1,
          name: "HostelConnect",
          slug: null,
          status: "active",
          student_limit: 300,
          building_limit: 20,
          fees_start_date: null,
        },
      ]);
    }));

  it("gives a new hostel the next id, active, with the beta limits", () =>
    inRollback(db, async (c) => {
      const id = await newHostel(c);
      expect(id).toBeGreaterThan(1);
      const { rows } = await c.query(
        "SELECT status, student_limit, building_limit FROM hostels WHERE id = $1",
        [id],
      );
      expect(rows).toEqual([{ status: "active", student_limit: 300, building_limit: 20 }]);
    }));

  it("takes a trimmed name of 1 to 100 characters", () =>
    inRollback(db, async (c) => {
      await newHostel(c, "A");
      await newHostel(c, "x".repeat(100));
      for (const name of ["", " ", " Leading", "Trailing ", "x".repeat(101)]) {
        expect(await pgError(c, "INSERT INTO hostels (name) VALUES ($1)", [name]), name).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "hostels_name_check",
        });
      }
    }));

  it("takes a slug for its students' address: 3 to 40 lowercase letters, digits and single hyphens", () =>
    inRollback(db, async (c) => {
      for (const slug of ["abc", "sns-hostel", "a1b", "hostel-2", `a${"b".repeat(38)}c`]) {
        await c.query("INSERT INTO hostels (name, slug) VALUES ('H', $1)", [slug]);
      }
      for (const slug of ["ab", "-abc", "abc-", "ABC", "a b", "a--b", "a_b", "abc/", `a${"b".repeat(39)}c`]) {
        expect(await pgError(c, "INSERT INTO hostels (name, slug) VALUES ('H', $1)", [slug]), slug).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "hostels_slug_check",
        });
      }
    }));

  it("never gives two hostels the same slug", () =>
    inRollback(db, async (c) => {
      await c.query("INSERT INTO hostels (name, slug) VALUES ('One', 'same-slug')");
      expect(await pgError(c, "INSERT INTO hostels (name, slug) VALUES ('Two', 'same-slug')")).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "hostels_slug_key",
      });
    }));

  it("allows only the statuses active and suspended, and limits above zero", () =>
    inRollback(db, async (c) => {
      // Only the platform admin sets these, and hostel_app may not even try (next test),
      // so the checks are read from the catalogue.
      const { rows } = await c.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'hostels'::regclass AND contype = 'c' ORDER BY conname`,
      );
      const defs = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
      expect(defs.hostels_status_check).toMatch(/'active'.*'suspended'/);
      expect(defs.hostels_student_limit_check).toMatch(/student_limit > 0/);
      expect(defs.hostels_building_limit_check).toMatch(/building_limit > 0/);
    }));

  it("lets the app create a hostel (name and slug only), rename it and set its fee start, nothing more", () =>
    inRollback(db, async (c) => {
      const id = await newHostel(c);
      await c.query("UPDATE hostels SET name = 'Renamed', slug = 'renamed', fees_start_date = '2026-12-01' WHERE id = $1", [
        id,
      ]);
      for (const [label, sql] of [
        ["insert a status", "INSERT INTO hostels (name, status) VALUES ('H', 'suspended')"],
        ["insert a limit", "INSERT INTO hostels (name, student_limit) VALUES ('H', 100000)"],
        ["change the status", `UPDATE hostels SET status = 'suspended' WHERE id = ${id}`],
        ["raise a limit", `UPDATE hostels SET student_limit = 100000 WHERE id = ${id}`],
        ["delete a hostel", `DELETE FROM hostels WHERE id = ${id}`],
      ]) {
        expect((await pgError(c, sql)).code, label).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

describe("hostel_id on every table that belongs to a hostel", () => {
  it("every table is either per hostel or deliberately not", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([...PER_HOSTEL, ...NOT_PER_HOSTEL].sort());
    }));

  it("each per-hostel table has hostel_id bigint NOT NULL DEFAULT current_hostel_id() (migration 016)", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ table_name: string; data_type: string; is_nullable: string; column_default: string }>(
        `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'hostel_id' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual(PER_HOSTEL);
      for (const row of rows) {
        expect(row, row.table_name).toMatchObject({ data_type: "bigint", is_nullable: "NO", column_default: "current_hostel_id()" });
      }
    }));

  it("puts rows written without a hostel in hostel #1, as today's code writes them", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const { building, room, bed1 } = await insertStructure(c);
      await c.query(
        `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
         VALUES ($1, $2, $3, $4, '2026-01-14', $5)`,
        [student, building, room, bed1, owner],
      );
      await c.query(
        `INSERT INTO complaints (student_id, category, description) VALUES ($1, 'plumbing', 'No water on the first floor')`,
        [student],
      );
      await c.query(`INSERT INTO announcements (author_id, title, body) VALUES ($1, 'Notice', 'Body text')`, [owner]);
      const { rows } = await c.query(
        `SELECT (SELECT hostel_id FROM users WHERE id = $1) AS owner,
                (SELECT hostel_id FROM users WHERE id = $2) AS student,
                (SELECT hostel_id FROM buildings WHERE id = $3) AS building,
                (SELECT hostel_id FROM beds WHERE id = $4) AS bed,
                (SELECT hostel_id FROM stays WHERE student_id = $2) AS stay,
                (SELECT hostel_id FROM complaints WHERE student_id = $2) AS complaint,
                (SELECT hostel_id FROM announcements WHERE author_id = $1) AS announcement`,
        [owner, student, building, bed1],
      );
      expect(rows[0]).toEqual({ owner: 1, student: 1, building: 1, bed: 1, stay: 1, complaint: 1, announcement: 1 });
    }));
});

describe("a row can never point into another hostel", () => {
  it("refuses accommodation that mixes hostels", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const { building } = await insertStructure(c); // hostel #1
      const floor = pgError(c, "INSERT INTO floors (hostel_id, building_id, number) VALUES ($1, $2, 2)", [other, building]);
      expect(await floor).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: "floors_hostel_building_fkey" });
      const room = pgError(c, "INSERT INTO rooms (hostel_id, building_id, room_number) VALUES ($1, $2, '9')", [
        other,
        building,
      ]);
      expect(await room).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: "rooms_hostel_building_fkey" });
    }));

  it("refuses a bed in another hostel's room", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const { room } = await insertStructure(c);
      expect(
        await pgError(c, "INSERT INTO beds (hostel_id, room_id, bed_number) VALUES ($1, $2, 'Z')", [other, room]),
      ).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: "beds_hostel_room_fkey" });
    }));

  it("refuses a stay for another hostel's student, building or owner", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const { building } = await insertStructure(c);
      const stay = "INSERT INTO stays (hostel_id, student_id, building_id, started_on, created_by) VALUES ($1, $2, $3, '2026-01-14', $4)";
      const err = await pgError(c, stay, [other, student, building, owner]);
      expect(err.code).toBe(FOREIGN_KEY_VIOLATION);
      expect(["stays_hostel_student_fkey", "stays_hostel_building_fkey", "stays_hostel_created_by_fkey"]).toContain(
        err.constraint,
      );
    }));

  it("refuses complaints, notices, polls, fees and notifications that reach into another hostel", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const cases: [string, string, unknown[]][] = [
        [
          "complaints_hostel_student_fkey",
          "INSERT INTO complaints (hostel_id, student_id, category, description) VALUES ($1, $2, 'plumbing', 'No water on the first floor')",
          [other, student],
        ],
        [
          "announcements_hostel_author_fkey",
          "INSERT INTO announcements (hostel_id, author_id, title, body) VALUES ($1, $2, 'Notice', 'Body text')",
          [other, owner],
        ],
        [
          "return_polls_hostel_created_by_fkey",
          "INSERT INTO return_polls (hostel_id, created_by, title) VALUES ($1, $2, 'Back after Diwali?')",
          [other, owner],
        ],
        [
          "fees_hostel_student_fkey",
          "INSERT INTO fees (hostel_id, student_id, due_date, amount) VALUES ($1, $2, '2026-12-14', 5000)",
          [other, student],
        ],
        [
          "notifications_hostel_user_fkey",
          "INSERT INTO notifications (hostel_id, user_id, type, title) VALUES ($1, $2, 'announcement', 'Hello')",
          [other, student],
        ],
        [
          "rejoin_requests_hostel_student_fkey",
          "INSERT INTO rejoin_requests (hostel_id, student_id) VALUES ($1, $2)",
          [other, student],
        ],
      ];
      for (const [constraint, sql, params] of cases) {
        expect(await pgError(c, sql, params), constraint).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint });
      }
    }));

  it("refuses a complaint event or a poll answer from another hostel", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const complaint = (
        await c.query<{ id: number }>(
          "INSERT INTO complaints (student_id, category, description) VALUES ($1, 'plumbing', 'No water on the first floor') RETURNING id",
          [student],
        )
      ).rows[0].id;
      const poll = (
        await c.query<{ id: number }>(
          "INSERT INTO return_polls (created_by, title) VALUES ($1, 'Back after Diwali?') RETURNING id",
          [owner],
        )
      ).rows[0].id;
      expect(
        await pgError(c, "INSERT INTO complaint_events (hostel_id, complaint_id, actor_id, kind) VALUES ($1, $2, $3, 'created')", [
          other,
          complaint,
          student,
        ]),
      ).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
      expect(
        await pgError(c, "INSERT INTO return_poll_responses (hostel_id, poll_id, student_id, response) VALUES ($1, $2, $3, 'returned')", [
          other,
          poll,
          student,
        ]),
      ).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    }));

  it("refuses a row for a hostel that does not exist", () =>
    inRollback(db, async (c) => {
      expect(await pgError(c, "INSERT INTO buildings (hostel_id, name) VALUES (999999, 'Nowhere')")).toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
        constraint: "buildings_hostel_id_fkey",
      });
    }));

  it("still allows a whole set of rows inside another hostel", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const id = async (sql: string, params: unknown[]) => (await c.query<{ id: number }>(sql, params)).rows[0].id;
      const building = await id("INSERT INTO buildings (hostel_id, name) VALUES ($1, 'Block A') RETURNING id", [other]);
      const floor = await id("INSERT INTO floors (hostel_id, building_id, number) VALUES ($1, $2, 0) RETURNING id", [
        other,
        building,
      ]);
      const room = await id(
        "INSERT INTO rooms (hostel_id, building_id, floor_id, room_number) VALUES ($1, $2, $3, 'G1') RETURNING id",
        [other, building, floor],
      );
      const bed = await id("INSERT INTO beds (hostel_id, room_id, bed_number) VALUES ($1, $2, 'A') RETURNING id", [
        other,
        room,
      ]);
      const owner = await id(
        "INSERT INTO users (hostel_id, role, name, email, password_hash) VALUES ($1, 'owner', 'Other Owner', 'other-owner@test.local', 'x') RETURNING id",
        [other],
      );
      const student = await id(
        `INSERT INTO users (hostel_id, role, name, email, password_hash, phone, parent_phone, category, joining_date, food_preference)
         VALUES ($1, 'student', 'Other Student', 'other-student@test.local', 'x', '9000000000', '9000000001', 'other', '2026-01-14', 'veg')
         RETURNING id`,
        [other],
      );
      await c.query(
        `INSERT INTO stays (hostel_id, student_id, building_id, room_id, bed_id, started_on, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-01-14', $6)`,
        [other, student, building, room, bed, owner],
      );
    }));
});

describe("hostel_id never changes", () => {
  it("refuses moving a row to another hostel, even where the app may change other columns", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      const owner = await insertOwner(c);
      const { building } = await insertStructure(c);
      for (const [table, rowId] of [
        ["users", owner],
        ["buildings", building],
      ] as const) {
        expect(await pgError(c, `UPDATE ${table} SET hostel_id = $1 WHERE id = $2`, [other, rowId]), table).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "hostel_id_fixed",
        });
      }
      // Other changes still work.
      await c.query("UPDATE buildings SET name = 'Renamed block' WHERE id = $1", [building]);
    }));

  it("guards every per-hostel table with the same trigger", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ table: string }>(
        `SELECT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = 'hostel_id_fixed' AND NOT t.tgisinternal ORDER BY c.relname`,
      );
      expect(rows.map((r) => r.table)).toEqual(PER_HOSTEL);
    }));
});

describe("per-hostel rules, next to today's global ones", () => {
  it("has per-hostel unique indexes for emails, building names, the open poll and payment settings", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
           'users_hostel_email_lower_key', 'buildings_hostel_name_lower_key',
           'return_polls_one_open_per_hostel', 'hostel_settings_hostel_key')
         ORDER BY indexname`,
      );
      const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
      expect(defs.users_hostel_email_lower_key).toMatch(/UNIQUE INDEX .* \(hostel_id, lower\(email\)\)/);
      expect(defs.buildings_hostel_name_lower_key).toMatch(/UNIQUE INDEX .* \(hostel_id, lower\(name\)\)/);
      expect(defs.return_polls_one_open_per_hostel).toMatch(/UNIQUE INDEX .* \(hostel_id\) WHERE \(status = 'open'::text\)/);
      expect(defs.hostel_settings_hostel_key).toMatch(/UNIQUE INDEX .* \(hostel_id\)/);
    }));

  it("keeps today's global rules until phase 2 (one email, one building name, one open poll overall)", () =>
    inRollback(db, async (c) => {
      const other = await newHostel(c);
      await c.query("INSERT INTO buildings (name) VALUES ('Shared Name')");
      expect(await pgError(c, "INSERT INTO buildings (hostel_id, name) VALUES ($1, 'shared name')", [other])).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "buildings_name_lower_key",
      });
    }));
});

describe("owners can sign in with Google", () => {
  it("stores an owner's Google account id, at most once", () =>
    inRollback(db, async (c) => {
      const a = await insertOwner(c);
      const b = await insertOwner(c);
      await c.query("UPDATE users SET google_sub = '1098765432109876543' WHERE id = $1", [a]);
      expect(
        await pgError(c, "UPDATE users SET google_sub = '1098765432109876543' WHERE id = $1", [b]),
      ).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "users_google_sub_key" });
    }));

  it("lets an owner with a Google account have no password, but never a student", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      await c.query("UPDATE users SET google_sub = 'sub-1', password_hash = NULL WHERE id = $1", [owner]);
      expect(await pgError(c, "UPDATE users SET google_sub = 'sub-2' WHERE id = $1", [student])).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: "users_google_owners_only",
      });
      expect(await pgError(c, "UPDATE users SET password_hash = NULL WHERE id = $1", [student])).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: "users_can_sign_in",
      });
      const plainOwner = await insertOwner(c);
      expect(await pgError(c, "UPDATE users SET password_hash = NULL WHERE id = $1", [plainOwner])).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: "users_can_sign_in",
      });
    }));

  it("refuses an empty or padded Google account id", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      for (const sub of ["", " ", " 123", "123 ", "x".repeat(256)]) {
        expect(await pgError(c, "UPDATE users SET google_sub = $1 WHERE id = $2", [sub, owner]), JSON.stringify(sub)).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "users_google_sub_check",
        });
      }
    }));
});

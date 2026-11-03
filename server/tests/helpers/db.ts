import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createPool, type Db } from "../../src/db";

// Database tests log in as hostel_app, the same limited role the app uses, so they
// also prove what that role is and is not allowed to do. DATABASE_URL already points
// at the throwaway test database here (tests/setup.ts).
// A missing DATABASE_URL fails loudly instead of skipping, so CI cannot pass by accident.
export function testPool(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; database tests need a migrated database");
  return createPool(url);
}

// Runs fn inside a transaction that is always rolled back, for tests that only need
// rows inside their own connection.
export async function inRollback(db: Db, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// Runs a statement that must fail and returns the Postgres error, so a test can check
// which constraint refused it. The savepoint keeps the surrounding transaction usable.
export async function pgError(
  c: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<{ code: string; constraint?: string; message: string }> {
  await c.query("SAVEPOINT expect_error");
  try {
    await c.query(sql, params);
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT expect_error");
    return err as { code: string; constraint?: string; message: string };
  }
  await c.query("RELEASE SAVEPOINT expect_error");
  throw new Error(`expected this statement to fail: ${sql}`);
}

// Either a pool (rows are committed, visible to the app under test) or a client
// inside inRollback (rows vanish at the end of the test).
type Queryable = Pick<PoolClient, "query">;

type UserOptions = {
  passwordHash?: string;
  mustChangePassword?: boolean;
  isActive?: boolean;
};

export async function insertOwner(c: Queryable, opts: UserOptions = {}): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active)
     VALUES ('owner', 'Test Owner', $1, $2, $3, $4) RETURNING id`,
    [
      `owner-${randomUUID()}@test.local`,
      opts.passwordHash ?? "not-a-real-hash",
      opts.mustChangePassword ?? false,
      opts.isActive ?? true,
    ],
  );
  return rows[0].id;
}

export async function insertStudent(c: Queryable, opts: UserOptions = {}): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference)
     VALUES ('student', 'Test Student', $1, $2, $3, $4,
             '9000000000', '9000000001', 'other', '2026-01-14', 'veg') RETURNING id`,
    [
      `student-${randomUUID()}@test.local`,
      opts.passwordHash ?? "not-a-real-hash",
      opts.mustChangePassword ?? false,
      opts.isActive ?? true,
    ],
  );
  return rows[0].id;
}

// A building with one floor, one room on that floor and two beds (A, B) in the room,
// written straight to the tables so a test does not depend on the code it checks.
export async function insertStructure(c: Queryable) {
  const id = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: number }>(sql, params)).rows[0].id;
  const buildingName = `Building ${randomUUID()}`;
  const building = await id("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [buildingName]);
  const floor = await id("INSERT INTO floors (building_id, number) VALUES ($1, 1) RETURNING id", [
    building,
  ]);
  const room = await id(
    "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, '101') RETURNING id",
    [building, floor],
  );
  const bed1 = await id("INSERT INTO beds (room_id, bed_number) VALUES ($1, 'A') RETURNING id", [room]);
  const bed2 = await id("INSERT INTO beds (room_id, bed_number) VALUES ($1, 'B') RETURNING id", [room]);
  return { building, buildingName, floor, room, bed1, bed2 };
}

// A current stay (or an ended one, with endedOn) for a new student.
export async function insertStay(
  c: Queryable,
  at: { building: number; room?: number; bed?: number; endedOn?: string },
): Promise<number> {
  const owner = await insertOwner(c);
  const student = await insertStudent(c);
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, ended_on, created_by)
     VALUES ($1, $2, $3, $4, '2026-01-14', $5, $6) RETURNING id`,
    [student, at.building, at.room ?? null, at.bed ?? null, at.endedOn ?? null, owner],
  );
  return rows[0].id;
}

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inSnapshot, insertStudent, testPool } from "./helpers/db";

// inSnapshot (tests/helpers/db.ts) runs a test body in one rolled-back REPEATABLE READ
// transaction and runs it again when Postgres refused it with a serialization failure
// (40001). That happens when the body writes a row that refers to a student another test
// file locked FOR UPDATE and then changed after the snapshot began (found on day 8; the
// app itself runs at READ COMMITTED, where it cannot happen). These tests cause that
// conflict on purpose with a second connection.
const db = testPool();
afterAll(() => db.end());

const SERIALIZATION_FAILURE = "40001";
const NOTIFY = `INSERT INTO notifications (user_id, type, title, link) VALUES ($1, 'announcement', 'Test', '/notices')`;

// What another test file's transfer or complaint does: lock the student row, change it,
// commit. Run on its own connection, after the body's snapshot has begun.
async function lockAndChange(studentId: number) {
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [studentId]);
    await other.query("UPDATE users SET name = 'Changed meanwhile' WHERE id = $1", [studentId]);
    await other.query("COMMIT");
  } finally {
    other.release();
  }
}

// Starts the snapshot, lets "another test file" change the student, then writes a
// notification for that student: Postgres refuses it with 40001.
async function conflict(c: PoolClient, studentId: number) {
  await c.query("SELECT 1");
  await lockAndChange(studentId);
  await c.query(NOTIFY, [studentId]);
}

describe("inSnapshot", () => {
  it("runs the body in REPEATABLE READ and rolls everything back", async () => {
    let title = "";
    await inSnapshot(db, async (c) => {
      const { rows } = await c.query("SHOW transaction_isolation");
      expect(rows[0].transaction_isolation).toBe("repeatable read");
      const student = await insertStudent(c);
      title = `Rolled back ${student}`;
      await c.query("INSERT INTO notifications (user_id, type, title) VALUES ($1, 'announcement', $2)", [
        student,
        title,
      ]);
    });
    const { rowCount } = await db.query("SELECT 1 FROM notifications WHERE title = $1", [title]);
    expect(rowCount).toBe(0);
  });

  it("runs the body again, in a new snapshot, after a serialization failure", async () => {
    const student = await insertStudent(db);
    let attempts = 0;
    await inSnapshot(db, async (c) => {
      attempts += 1;
      if (attempts === 1) await conflict(c, student);
      else await c.query(NOTIFY, [student]); // the new snapshot sees the change: no conflict
    });
    expect(attempts).toBe(2);
  });

  it("also retries when the failure was caught inside the body, as the app turns it into a 500", async () => {
    const student = await insertStudent(db);
    let attempts = 0;
    await inSnapshot(db, async (c) => {
      attempts += 1;
      if (attempts > 1) return;
      // As rollbackDb runs the app: its transaction is a savepoint, the app rolls back to
      // it and answers 500, and the test then fails on the status, not on the 40001.
      await c.query("SAVEPOINT app");
      try {
        await conflict(c, student);
      } catch {
        await c.query("ROLLBACK TO SAVEPOINT app");
      }
      expect(500, "the answer's status").toBe(201);
    });
    expect(attempts).toBe(2);
  });

  it("gives up after 3 attempts with the serialization failure", async () => {
    let attempts = 0;
    const err = await inSnapshot(db, async (c) => {
      attempts += 1;
      await conflict(c, await insertStudent(db));
    }).catch((e: unknown) => e);
    expect(attempts).toBe(3);
    expect(err).toMatchObject({ code: SERIALIZATION_FAILURE });
  });

  it("does not retry any other failure", async () => {
    let attempts = 0;
    const err = await inSnapshot(db, async () => {
      attempts += 1;
      throw new Error("an ordinary test failure");
    }).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(err).toMatchObject({ message: "an ordinary test failure" });

    attempts = 0;
    const sqlErr = await inSnapshot(db, async (c) => {
      attempts += 1;
      await c.query("SELECT * FROM no_such_table");
    }).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(sqlErr).toMatchObject({ code: "42P01" });
  });
});

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, insertStudent, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for return polls and their answers (migration
// 012), so they hold even if a service function has a bug. Run as hostel_app, the role the
// app uses, inside transactions that are rolled back.
//
// At most one poll is open at a time. Another test file opening a poll at the same moment
// makes this file's insert wait for that transaction to end (unique index), not fail:
// every test here rolls back.
const db = testPool();
afterAll(() => db.end());

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

const TITLE = "Back after Diwali?";

const OPEN = `INSERT INTO return_polls (title, created_by) VALUES ($1, $2) RETURNING id`;
const CLOSED = `INSERT INTO return_polls (title, created_by, status, closed_at)
                VALUES ($1, $2, 'closed', now()) RETURNING id`;
async function poll(c: PoolClient, owner: number, sql = OPEN, title = TITLE): Promise<number> {
  const { rows } = await c.query<{ id: number }>(sql, [title, owner]);
  return rows[0].id;
}

const ANSWER = `INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, $3)`;

describe("return_polls", () => {
  it("records a new poll as open, created now, with no closing time", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await poll(c, owner);
      const { rows } = await c.query(
        `SELECT title, status, created_by, created_at = now() AS created_now, closed_at
         FROM return_polls WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        title: TITLE,
        status: "open",
        created_by: owner,
        created_now: true,
        closed_at: null,
      });
    }));

  it("takes a title of 1 to 120 characters, stored trimmed", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      for (const [label, title] of [
        ["empty", ""],
        ["blank", "  \t"],
        ["121 characters", "x".repeat(121)],
        ["121 emoji", "🏠".repeat(121)],
        ["untrimmed", ` ${TITLE}`],
        ["line break at the end", `${TITLE}\n`],
      ] as const) {
        const err = await pgError(c, CLOSED, [title, owner]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint: "return_polls_title_check" });
      }
      for (const title of ["x", "x".repeat(120), "🏠".repeat(120)]) {
        await poll(c, owner, CLOSED, title);
      }
    }));

  it("is open with no closing time or closed with one, nothing else", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      for (const [label, sql, constraint] of [
        [
          "open with a closing time",
          `INSERT INTO return_polls (title, created_by, closed_at) VALUES ($1, $2, now())`,
          "return_polls_closed",
        ],
        [
          "closed with no closing time",
          `INSERT INTO return_polls (title, created_by, status) VALUES ($1, $2, 'closed')`,
          "return_polls_closed",
        ],
        [
          "another status",
          `INSERT INTO return_polls (title, created_by, status, closed_at) VALUES ($1, $2, 'draft', now())`,
          "return_polls_status_check",
        ],
      ] as const) {
        const err = await pgError(c, sql, [TITLE, owner]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
    }));

  it("allows only one open poll, any number of closed ones, and a new one once it closes", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      await poll(c, owner, CLOSED);
      await poll(c, owner, CLOSED);
      const first = await poll(c, owner);

      const err = await pgError(c, OPEN, ["Second poll", owner]);
      expect(err).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "return_polls_one_open" });

      await c.query(`UPDATE return_polls SET status = 'closed', closed_at = now() WHERE id = $1`, [first]);
      await poll(c, owner, OPEN, "Second poll");
    }));

  it("needs an owner who exists and a title", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      expect((await pgError(c, CLOSED, [TITLE, 999_999_999])).code).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(c, CLOSED, [TITLE, null])).code).toBe(NOT_NULL_VIOLATION);
      expect((await pgError(c, CLOSED, [null, owner])).code).toBe(NOT_NULL_VIOLATION);
    }));

  it("lets the app close a poll, never rename it, change who or when, or delete it", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const someoneElse = await insertOwner(c);
      const id = await poll(c, owner);

      await c.query(`UPDATE return_polls SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
      for (const [sql, params] of [
        ["UPDATE return_polls SET title = 'Renamed' WHERE id = $1", [id]],
        ["UPDATE return_polls SET created_by = $2 WHERE id = $1", [id, someoneElse]],
        ["UPDATE return_polls SET created_at = now() WHERE id = $1", [id]],
        ["DELETE FROM return_polls WHERE id = $1", [id]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));

  // Documents a limit, not a wish: closing is final only because the service refuses a
  // reopen (decided on day 9). If this ever fails, the database started enforcing it.
  it("does not itself stop a closed poll being set open again; the service must", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await poll(c, owner, CLOSED);
      const { rowCount } = await c.query(
        `UPDATE return_polls SET status = 'open', closed_at = NULL WHERE id = $1`,
        [id],
      );
      expect(rowCount).toBe(1);
    }));
});

describe("return_poll_responses", () => {
  it("records an answer, answered now", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await poll(c, owner, CLOSED);
      await c.query(ANSWER, [id, student, "returned"]);
      const { rows } = await c.query(
        `SELECT response, responded_at = now() AS answered_now
         FROM return_poll_responses WHERE poll_id = $1 AND student_id = $2`,
        [id, student],
      );
      expect(rows[0]).toEqual({ response: "returned", answered_now: true });
    }));

  it("takes 'returned' or 'not_yet' only", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await poll(c, owner, CLOSED);
      for (const response of ["", "yes", "Returned", "not yet"]) {
        const err = await pgError(c, ANSWER, [id, student, response]);
        expect(err, response).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "return_poll_responses_response_check",
        });
      }
      expect((await pgError(c, ANSWER, [id, student, null])).code).toBe(NOT_NULL_VIOLATION);
      await c.query(ANSWER, [id, student, "not_yet"]);
    }));

  it("keeps one answer per student per poll", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      const first = await poll(c, owner, CLOSED);
      const second = await poll(c, owner, CLOSED);
      await c.query(ANSWER, [first, student, "returned"]);

      const err = await pgError(c, ANSWER, [first, student, "not_yet"]);
      expect(err).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "return_poll_responses_pkey" });
      await c.query(ANSWER, [second, student, "not_yet"]);
      await c.query(ANSWER, [first, other, "not_yet"]);
    }));

  it("needs a poll and a student who exist", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const id = await poll(c, owner, CLOSED);
      expect((await pgError(c, ANSWER, [999_999_999, student, "returned"])).code).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(c, ANSWER, [id, 999_999_999, "returned"])).code).toBe(FOREIGN_KEY_VIOLATION);
    }));

  it("lets the app change an answer, never move it to another poll or student, or delete it", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const other = await insertStudent(c);
      const id = await poll(c, owner, CLOSED);
      const another = await poll(c, owner, CLOSED);
      await c.query(ANSWER, [id, student, "not_yet"]);

      await c.query(
        `UPDATE return_poll_responses SET response = 'returned', responded_at = now()
         WHERE poll_id = $1 AND student_id = $2`,
        [id, student],
      );
      for (const [sql, params] of [
        ["UPDATE return_poll_responses SET poll_id = $3 WHERE poll_id = $1 AND student_id = $2", [id, student, another]],
        ["UPDATE return_poll_responses SET student_id = $3 WHERE poll_id = $1 AND student_id = $2", [id, student, other]],
        ["DELETE FROM return_poll_responses WHERE poll_id = $1 AND student_id = $2", [id, student]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

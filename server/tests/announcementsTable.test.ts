import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertOwner, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for announcements (migration 010), so they hold
// even if a service function has a bug. Run as hostel_app, the role the app uses, inside
// transactions that are rolled back.
const db = testPool();
afterAll(() => db.end());

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

const TITLE = "Water off on Sunday";
const BODY = "The tank is being cleaned from 9 am to 1 pm. Please store water the night before.";

const POST = `INSERT INTO announcements (author_id, title, body) VALUES ($1, $2, $3) RETURNING id`;
async function post(c: PoolClient, author: number, title = TITLE, body = BODY): Promise<number> {
  const { rows } = await c.query<{ id: number }>(POST, [author, title, body]);
  return rows[0].id;
}

describe("announcements", () => {
  it("records a new announcement as neither urgent nor pinned, created and updated now", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const id = await post(c, owner);
      const { rows } = await c.query(
        `SELECT author_id, title, body, is_urgent, is_pinned,
                created_at = now() AS created_now, updated_at = now() AS updated_now
         FROM announcements WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        author_id: owner,
        title: TITLE,
        body: BODY,
        is_urgent: false,
        is_pinned: false,
        created_now: true,
        updated_now: true,
      });
    }));

  it("takes a title of 1 to 120 characters and a body of 1 to 2000, both stored trimmed", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      for (const [label, title, body, constraint] of [
        ["empty title", "", BODY, "announcements_title_check"],
        ["blank title", "   ", BODY, "announcements_title_check"],
        ["121-character title", "x".repeat(121), BODY, "announcements_title_check"],
        ["121-emoji title", "📢".repeat(121), BODY, "announcements_title_check"],
        ["untrimmed title", ` ${TITLE}`, BODY, "announcements_title_check"],
        ["title with a line break at the end", `${TITLE}\n`, BODY, "announcements_title_check"],
        ["empty body", TITLE, "", "announcements_body_check"],
        ["blank body", TITLE, "\n\t ", "announcements_body_check"],
        ["2001-character body", TITLE, "x".repeat(2001), "announcements_body_check"],
        ["untrimmed body", TITLE, `${BODY} `, "announcements_body_check"],
      ] as const) {
        const err = await pgError(c, POST, [owner, title, body]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
      for (const [title, body] of [
        ["x", "y"],
        ["x".repeat(120), "y".repeat(2000)],
        ["📢".repeat(120), "🚿".repeat(2000)],
        [TITLE, "Line one.\n\nLine two."],
      ]) {
        await post(c, owner, title, body);
      }
    }));

  it("needs an author who exists, a title and a body", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      expect((await pgError(c, POST, [999_999_999, TITLE, BODY])).code).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(c, POST, [null, TITLE, BODY])).code).toBe(NOT_NULL_VIOLATION);
      expect((await pgError(c, POST, [owner, null, BODY])).code).toBe(NOT_NULL_VIOLATION);
      expect((await pgError(c, POST, [owner, TITLE, null])).code).toBe(NOT_NULL_VIOLATION);
    }));

  it("lets the app edit, pin, mark urgent and delete, but never change the author or creation time", () =>
    inRollback(db, async (c) => {
      const owner = await insertOwner(c);
      const someoneElse = await insertOwner(c);
      const id = await post(c, owner);

      await c.query(
        `UPDATE announcements
         SET title = 'Water off on Monday', body = 'Moved to Monday.', is_urgent = true, is_pinned = true,
             updated_at = now()
         WHERE id = $1`,
        [id],
      );
      for (const [sql, params] of [
        ["UPDATE announcements SET author_id = $2 WHERE id = $1", [id, someoneElse]],
        ["UPDATE announcements SET created_at = now() WHERE id = $1", [id]],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }

      await c.query("DELETE FROM announcements WHERE id = $1", [id]);
      const { rowCount } = await c.query("SELECT 1 FROM announcements WHERE id = $1", [id]);
      expect(rowCount).toBe(0);
    }));

  it("has the index for 'pinned first, then newest'", () =>
    inRollback(db, async (c) => {
      const { rows } = await c.query(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'announcements' AND indexname = 'announcements_pinned_created'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain("(is_pinned DESC, created_at DESC)");
    }));
});

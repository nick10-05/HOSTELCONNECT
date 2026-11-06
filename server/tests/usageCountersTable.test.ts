import { afterAll, describe, expect, it } from "vitest";
import { inRollback, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for the usage counters (migration 011), so they
// hold even if a service function has a bug. Run as hostel_app, the role the app uses,
// inside transactions that are rolled back. The months are far in the past so no other
// test file can be writing the same key.
const db = testPool();
afterAll(() => db.end());

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const INSUFFICIENT_PRIVILEGE = "42501";

// How the usage guard will add a photo's size to the month's egress.
const ADD = `INSERT INTO usage_counters (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE
               SET value = usage_counters.value + EXCLUDED.value, updated_at = now()
             RETURNING value`;

describe("usage_counters", () => {
  it("starts a month's counter at the first amount and adds to it after that", () =>
    inRollback(db, async (c) => {
      const first = await c.query(
        `INSERT INTO usage_counters (key) VALUES ('egress:1990-01')
         RETURNING value, updated_at = now() AS updated_now`,
      );
      expect(first.rows[0]).toEqual({ value: 0, updated_now: true });

      expect((await c.query(ADD, ["egress:1990-02", 500_000])).rows[0].value).toBe(500000);
      expect((await c.query(ADD, ["egress:1990-02", 250_000])).rows[0].value).toBe(750000);
      // Beyond what a 32-bit integer holds: a month can pass 2 GB of egress.
      expect((await c.query(ADD, ["egress:1990-02", 3_000_000_000])).rows[0].value).toBe(3000750000);
      // Another month is its own row.
      expect((await c.query(ADD, ["egress:1990-03", 1])).rows[0].value).toBe(1);
    }));

  it("takes keys of the form 'name:YYYY-MM' only", () =>
    inRollback(db, async (c) => {
      for (const key of [
        "",
        "egress",
        "egress:1990",
        "egress:1990-1",
        "egress:1990-00",
        "egress:1990-13",
        "egress:1990-01-01",
        "Egress:1990-01",
        " egress:1990-01",
        "egress:1990-01 ",
        "egress-1990-01",
      ]) {
        const err = await pgError(c, ADD, [key, 1]);
        expect(err, JSON.stringify(key)).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "usage_counters_key_format",
        });
      }
      for (const key of ["egress:1990-04", "egress:1990-12", "photo_egress:1990-10"]) {
        await c.query(ADD, [key, 1]);
      }
    }));

  it("never holds a negative value or a missing one", () =>
    inRollback(db, async (c) => {
      expect(await pgError(c, ADD, ["egress:1991-01", -1])).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: "usage_counters_value_check",
      });
      await c.query(ADD, ["egress:1991-02", 10]);
      expect(await pgError(c, ADD, ["egress:1991-02", -11])).toMatchObject({
        code: CHECK_VIOLATION,
        constraint: "usage_counters_value_check",
      });
      expect((await pgError(c, "INSERT INTO usage_counters (key, value) VALUES ('egress:1991-03', NULL)")).code).toBe(
        NOT_NULL_VIOLATION,
      );
    }));

  it("lets the app read and add to a counter, but never delete one or change its key", () =>
    inRollback(db, async (c) => {
      await c.query(ADD, ["egress:1992-01", 100]);
      await c.query("UPDATE usage_counters SET value = value + 1, updated_at = now() WHERE key = 'egress:1992-01'");
      const { rows } = await c.query("SELECT value FROM usage_counters WHERE key = 'egress:1992-01'");
      expect(rows[0].value).toBe(101);

      for (const sql of [
        "DELETE FROM usage_counters WHERE key = 'egress:1992-01'",
        "TRUNCATE usage_counters",
        "UPDATE usage_counters SET key = 'egress:1992-02' WHERE key = 'egress:1992-01'",
      ]) {
        const err = await pgError(c, sql);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});

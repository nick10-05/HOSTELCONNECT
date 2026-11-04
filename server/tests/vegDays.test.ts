import { afterAll, describe, expect, it } from "vitest";
import { inRollback, insertStudent, pgError, testPool } from "./helpers/db";

// Migration 006: the database itself refuses impossible veg days, whatever the app
// sends. Each test runs as hostel_app inside a transaction that is rolled back.
const db = testPool();
afterAll(() => db.end());

const setDays = "UPDATE users SET food_preference = $2, veg_days = $3 WHERE id = $1";

describe("users.veg_days", () => {
  it("is empty for a new student", async () => {
    await inRollback(db, async (c) => {
      const id = await insertStudent(c);
      const { rows } = await c.query("SELECT veg_days FROM users WHERE id = $1", [id]);
      expect(rows[0].veg_days).toEqual([]);
    });
  });

  it("accepts weekdays for a non-veg student", async () => {
    await inRollback(db, async (c) => {
      const id = await insertStudent(c);
      await c.query(setDays, [id, "non_veg", [2, 6]]);
      const { rows } = await c.query("SELECT veg_days FROM users WHERE id = $1", [id]);
      expect(rows[0].veg_days).toEqual([2, 6]);
    });
  });

  it("refuses veg days for a veg student", async () => {
    await inRollback(db, async (c) => {
      const id = await insertStudent(c);
      const err = await pgError(c, setDays, [id, "veg", [2]]);
      expect(err).toMatchObject({ code: "23514", constraint: "users_veg_days_non_veg_only" });
    });
  });

  it("refuses numbers that are not weekdays, repeats and empty entries", async () => {
    await inRollback(db, async (c) => {
      const id = await insertStudent(c);
      for (const days of [[0], [8], [2, 2], [null]]) {
        const err = await pgError(c, setDays, [id, "non_veg", days]);
        expect(err).toMatchObject({ code: "23514", constraint: "users_veg_days_valid" });
      }
    });
  });

  it("refuses switching a student with veg days to veg without clearing them", async () => {
    await inRollback(db, async (c) => {
      const id = await insertStudent(c);
      await c.query(setDays, [id, "non_veg", [7]]);
      const err = await pgError(c, "UPDATE users SET food_preference = 'veg' WHERE id = $1", [id]);
      expect(err).toMatchObject({ constraint: "users_veg_days_non_veg_only" });
    });
  });
});

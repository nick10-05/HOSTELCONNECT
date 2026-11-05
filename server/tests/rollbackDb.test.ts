import { afterAll, describe, expect, it } from "vitest";
import { inRollback, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The test helper itself: the app's transactions become savepoints inside the test's
// transaction, and the test's rollback undoes everything.
const db = testPool();
afterAll(() => db.end());

const NAME = () => `Helper block ${Math.random()}`;
const exists = async (name: string) =>
  (await db.query("SELECT 1 FROM buildings WHERE name = $1", [name])).rowCount === 1;

describe("rollbackDb", () => {
  it("keeps a committed app transaction inside the test, and the test's rollback removes it", async () => {
    const name = NAME();
    await inRollback(db, async (c) => {
      const appDb = rollbackDb(c);
      const client = await appDb.connect();
      await client.query("BEGIN");
      await client.query("INSERT INTO buildings (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      client.release();
      // Visible on the test's connection, through the stand-in's own query too.
      expect((await appDb.query("SELECT 1 FROM buildings WHERE name = $1", [name])).rowCount).toBe(1);
      // Not visible to anyone else: it is not committed.
      expect(await exists(name)).toBe(false);
    });
    expect(await exists(name)).toBe(false);
  });

  it("undoes only the app's own part when the app rolls back", async () => {
    const kept = NAME();
    const undone = NAME();
    await inRollback(db, async (c) => {
      await c.query("INSERT INTO buildings (name) VALUES ($1)", [kept]);
      const client = await rollbackDb(c).connect();
      await client.query("BEGIN");
      await client.query("INSERT INTO buildings (name) VALUES ($1)", [undone]);
      await client.query("ROLLBACK");
      const { rows } = await c.query("SELECT name FROM buildings WHERE name = ANY($1) ORDER BY name", [[kept, undone]]);
      expect(rows).toEqual([{ name: kept }]);
    });
  });

  it("recovers from a failed statement inside the app's transaction", async () => {
    await inRollback(db, async (c) => {
      const client = await rollbackDb(c).connect();
      await client.query("BEGIN");
      await expect(client.query("INSERT INTO buildings (name) VALUES (NULL)")).rejects.toThrow();
      await client.query("ROLLBACK");
      // The test's transaction is still usable.
      expect((await c.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  });
});

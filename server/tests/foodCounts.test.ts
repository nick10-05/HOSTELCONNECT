import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getFoodCounts, type FoodCount, type FoodCounts } from "../src/services/food";
import { inSnapshot, insertOwner, testPool } from "./helpers/db";

// The cook's counts for a date (day 8): who has a stay covering the date, veg or non-veg,
// with non-veg students moved to the veg side on their veg days; overall and per building.
// Other test files commit students at the same time, so every test runs in one rolled-back
// snapshot (the shared inSnapshot) and checks the overall numbers as a change from a
// baseline taken inside it. Its own buildings have random names, so their counts are exact.
const db = testPool();
afterAll(() => db.end());

const TUESDAY = "2031-03-04"; // ISO weekday 2
const SUNDAY = "2031-03-09"; // ISO weekday 7
const MONDAY = "2031-03-03"; // ISO weekday 1

async function newBuilding(c: PoolClient, name = `Food ${randomUUID()}`): Promise<number> {
  const { rows } = await c.query<{ id: number }>("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]);
  return rows[0].id;
}

type Eater = { food: "veg" | "non_veg"; vegDays?: number[]; isActive?: boolean };
type Stay = { building: number; from: string; until?: string | null };

// A student and their stays, written straight to the tables.
async function student(c: PoolClient, eater: Eater, ...stays: Stay[]): Promise<number> {
  const owner = await insertOwner(c);
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference, veg_days)
     VALUES ('student', 'Food Student', $1, 'not-a-real-hash', false, $2,
             '9000000000', '9000000001', 'other', $3, $4, $5) RETURNING id`,
    [`food-${randomUUID()}@test.local`, eater.isActive ?? true, stays[0].from, eater.food, eater.vegDays ?? []],
  );
  for (const stay of stays) {
    await c.query(
      `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].id, stay.building, stay.from, stay.until ?? null, owner],
    );
  }
  return rows[0].id;
}

const countIn = (counts: FoodCounts, building: number): FoodCount => {
  const found = counts.buildings.find((b) => b.buildingId === building);
  if (!found) throw new Error(`building ${building} is missing from the counts`);
  return { veg: found.veg, nonVeg: found.nonVeg, total: found.total };
};
const minus = (a: FoodCount, b: FoodCount): FoodCount => ({
  veg: a.veg - b.veg,
  nonVeg: a.nonVeg - b.nonVeg,
  total: a.total - b.total,
});

describe("getFoodCounts", () => {
  it("counts veg and non-veg students, moving non-veg ones to veg on their veg days", () =>
    inSnapshot(db, async (c) => {
      const before = { tuesday: await getFoodCounts(c, TUESDAY), sunday: await getFoodCounts(c, SUNDAY) };
      const a = await newBuilding(c);
      const since = { building: a, from: "2031-01-01" };
      await student(c, { food: "veg" }, since);
      await student(c, { food: "veg" }, since);
      await student(c, { food: "non_veg" }, since);
      await student(c, { food: "non_veg", vegDays: [2] }, since); // veg on Tuesdays
      await student(c, { food: "non_veg", vegDays: [2, 7] }, since); // veg on Tuesdays and Sundays
      await student(c, { food: "non_veg", vegDays: [1, 3, 4, 5, 6] }, since); // never Tue or Sun

      const tuesday = await getFoodCounts(c, TUESDAY);
      expect(tuesday).toMatchObject({ date: TUESDAY, weekday: 2 });
      expect(countIn(tuesday, a)).toEqual({ veg: 4, nonVeg: 2, total: 6 });
      expect(minus(tuesday.overall, before.tuesday.overall)).toEqual({ veg: 4, nonVeg: 2, total: 6 });

      const sunday = await getFoodCounts(c, SUNDAY);
      expect(sunday).toMatchObject({ date: SUNDAY, weekday: 7 });
      expect(countIn(sunday, a)).toEqual({ veg: 3, nonVeg: 3, total: 6 });
      expect(minus(sunday.overall, before.sunday.overall)).toEqual({ veg: 3, nonVeg: 3, total: 6 });

      expect((await getFoodCounts(c, MONDAY)).weekday).toBe(1);
    }));

  it("counts only students whose stay covers the date", () =>
    inSnapshot(db, async (c) => {
      const before = await getFoodCounts(c, TUESDAY);
      const a = await newBuilding(c);
      const veg = { food: "veg" } as const;
      await student(c, veg, { building: a, from: TUESDAY }); // joins that day: counted
      await student(c, veg, { building: a, from: "2031-03-05" }); // joins the day after: not yet
      await student(c, veg, { building: a, from: "2031-01-01", until: TUESDAY }); // leaves that day: not
      await student(c, veg, { building: a, from: "2031-01-01", until: "2031-03-03" }); // left before: not
      await student(c, veg, { building: a, from: "2031-01-01", until: "2031-03-05" }); // leaves after: counted

      const counts = await getFoodCounts(c, TUESDAY);
      expect(countIn(counts, a)).toEqual({ veg: 2, nonVeg: 0, total: 2 });
      expect(minus(counts.overall, before.overall)).toEqual({ veg: 2, nonVeg: 0, total: 2 });
    }));

  it("counts a student who moves only in the new building, from the move day", () =>
    inSnapshot(db, async (c) => {
      const before = await getFoodCounts(c, TUESDAY);
      const [a, b] = [await newBuilding(c), await newBuilding(c)];
      await student(c, { food: "non_veg" }, { building: a, from: "2031-01-01", until: TUESDAY }, { building: b, from: TUESDAY });

      const moveDay = await getFoodCounts(c, TUESDAY);
      expect(countIn(moveDay, a)).toEqual({ veg: 0, nonVeg: 0, total: 0 });
      expect(countIn(moveDay, b)).toEqual({ veg: 0, nonVeg: 1, total: 1 });
      expect(minus(moveDay.overall, before.overall)).toEqual({ veg: 0, nonVeg: 1, total: 1 });

      const dayBefore = await getFoodCounts(c, MONDAY);
      expect(countIn(dayBefore, a)).toEqual({ veg: 0, nonVeg: 1, total: 1 });
      expect(countIn(dayBefore, b)).toEqual({ veg: 0, nonVeg: 0, total: 0 });
    }));

  it("counts a moved-out student on a date they still lived there", () =>
    inSnapshot(db, async (c) => {
      const a = await newBuilding(c);
      await student(c, { food: "veg", isActive: false }, { building: a, from: "2031-01-01", until: "2031-03-05" });
      expect(countIn(await getFoodCounts(c, TUESDAY), a)).toEqual({ veg: 1, nonVeg: 0, total: 1 });
      expect(countIn(await getFoodCounts(c, "2031-03-05"), a)).toEqual({ veg: 0, nonVeg: 0, total: 0 });
    }));

  it("lists every building, empty ones with zeros, by name ignoring case", () =>
    inSnapshot(db, async (c) => {
      const tag = randomUUID();
      const zebra = await newBuilding(c, `zebra ${tag}`);
      const apple = await newBuilding(c, `Apple ${tag}`);
      const mango = await newBuilding(c, `mango ${tag}`);
      await student(c, { food: "veg" }, { building: mango, from: "2031-01-01" });

      const counts = await getFoodCounts(c, TUESDAY);
      const mine = counts.buildings.filter((b) => b.buildingName.endsWith(tag));
      expect(mine).toEqual([
        { buildingId: apple, buildingName: `Apple ${tag}`, veg: 0, nonVeg: 0, total: 0 },
        { buildingId: mango, buildingName: `mango ${tag}`, veg: 1, nonVeg: 0, total: 1 },
        { buildingId: zebra, buildingName: `zebra ${tag}`, veg: 0, nonVeg: 0, total: 0 },
      ]);
      // Other files' buildings are ordered by the database's collation, which a JavaScript
      // sort does not reproduce, so only this test's three are checked for order. The id
      // tie-break cannot be reached: names are unique ignoring case. The overall numbers
      // are the sum over every building.
      const sum = counts.buildings.reduce(
        (acc, b) => ({ veg: acc.veg + b.veg, nonVeg: acc.nonVeg + b.nonVeg, total: acc.total + b.total }),
        { veg: 0, nonVeg: 0, total: 0 },
      );
      expect(counts.overall).toEqual(sum);
    }));

  it("answers with exactly these fields, counts only", () =>
    inSnapshot(db, async (c) => {
      const counts = await getFoodCounts(c, TUESDAY);
      expect(Object.keys(counts).sort()).toEqual(["buildings", "date", "overall", "weekday"]);
      expect(Object.keys(counts.overall).sort()).toEqual(["nonVeg", "total", "veg"]);
      for (const b of counts.buildings) {
        expect(Object.keys(b).sort()).toEqual(["buildingId", "buildingName", "nonVeg", "total", "veg"]);
      }
    }));
});

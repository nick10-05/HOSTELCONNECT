import type { Queryable } from "../db";

// Food counts for the cook (design doc, sections 2 and 9; day 8, written by Claude at
// Nikhil's request). tests/foodCounts.test.ts describes getFoodCounts.

export type FoodCount = { veg: number; nonVeg: number; total: number };
export type BuildingFoodCount = FoodCount & { buildingId: number; buildingName: string };

export type FoodCounts = {
  date: string; // 'YYYY-MM-DD', as asked
  weekday: number; // ISO: 1 = Monday ... 7 = Sunday, as veg_days numbers them
  overall: FoodCount;
  buildings: BuildingFoodCount[];
};

// How many students eat veg and non-veg on `date` ('YYYY-MM-DD', India's date; the route
// checks it and defaults to hostelToday()), overall and per building.
//
// Who counts (decided on day 8): every student with a stay that covers the date,
//   started_on <= date AND (ended_on IS NULL OR ended_on > date)
// so a student counts from their joining day; on a move day only in the new building
// (the old stay ends that day, the new one starts it); not on the day they move out.
// is_active is not looked at: a past date counts who lived there then, and a moved-out
// student's stays have all ended. Food preference and veg days are today's (they keep no
// history).
//
// Veg side (veg days, decided on day 4): veg students, plus non-veg students whose
// veg_days include the date's weekday. Non-veg side: the other non-veg students.
// total = veg + nonVeg.
//
// buildings: every building, empty ones included with zeros, ordered by name ignoring
// case (lower(name)), then id, as on the dashboard. overall is the sum over buildings.
// Read-only, outside a transaction; no names or phone numbers, counts only.
export async function getFoodCounts(db: Queryable, date: string): Promise<FoodCounts> {
  // The calendar date's weekday, whatever the server's time zone: getUTCDay of midnight
  // UTC is 0 = Sunday ... 6 = Saturday; ISO Sunday is 7.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

  // A veg day turns a non-veg student veg; a veg student's veg_days is always empty.
  const { rows } = await db.query<BuildingFoodCount>(
    `SELECT b.id AS "buildingId", b.name AS "buildingName",
            count(u.id) FILTER (WHERE u.food_preference = 'veg' OR $2::smallint = ANY (u.veg_days))::int AS veg,
            count(u.id) FILTER (WHERE u.food_preference = 'non_veg'
                                  AND NOT ($2::smallint = ANY (u.veg_days)))::int AS "nonVeg",
            count(u.id)::int AS total
     FROM buildings b
     LEFT JOIN stays s ON s.building_id = b.id
                      AND s.started_on <= $1::date
                      AND (s.ended_on IS NULL OR s.ended_on > $1::date)
     LEFT JOIN users u ON u.id = s.student_id AND u.role = 'student'
     GROUP BY b.id
     ORDER BY lower(b.name), b.id`,
    [date, weekday],
  );

  const overall = rows.reduce(
    (sum, b) => ({ veg: sum.veg + b.veg, nonVeg: sum.nonVeg + b.nonVeg, total: sum.total + b.total }),
    { veg: 0, nonVeg: 0, total: 0 },
  );
  return { date, weekday, overall, buildings: rows };
}

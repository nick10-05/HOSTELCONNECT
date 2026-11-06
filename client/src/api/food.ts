import { apiFetch } from "./client";

// The cook's food counts. Shapes match server/src/services/food.ts and routes/food.ts.

export type FoodCount = { veg: number; nonVeg: number; total: number };
export type BuildingFoodCount = FoodCount & { buildingId: number; buildingName: string };

export type FoodCounts = {
  date: string; // 'YYYY-MM-DD', the day counted
  weekday: number; // 1 = Monday ... 7 = Sunday
  pollId: number | null; // the return poll counted by (only who answered "returned"); null: everyone
  overall: FoodCount;
  buildings: BuildingFoodCount[];
};

// GET /api/food-counts: for `date` ('YYYY-MM-DD'), or India's today when it is left out;
// with `pollId`, only the students who answered "returned" to that poll.
// 404 "poll_not_found" for an unknown poll.
export async function getFoodCounts(date?: string, pollId?: number): Promise<FoodCounts> {
  const query = new URLSearchParams();
  if (date) query.set("date", date);
  if (pollId !== undefined) query.set("pollId", String(pollId));
  const text = query.toString();
  return apiFetch<FoodCounts>(text ? `/api/food-counts?${text}` : "/api/food-counts");
}

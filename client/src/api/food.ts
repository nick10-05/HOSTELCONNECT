import { apiFetch } from "./client";

// The cook's food counts. Shapes match server/src/services/food.ts.

export type FoodCount = { veg: number; nonVeg: number; total: number };
export type BuildingFoodCount = FoodCount & { buildingId: number; buildingName: string };

export type FoodCounts = {
  date: string; // 'YYYY-MM-DD', the day counted
  weekday: number; // 1 = Monday ... 7 = Sunday
  overall: FoodCount;
  buildings: BuildingFoodCount[];
};

// GET /api/food-counts: for `date` ('YYYY-MM-DD'), or India's today when it is left out.
export async function getFoodCounts(date?: string): Promise<FoodCounts> {
  return apiFetch<FoodCounts>(date ? `/api/food-counts?${new URLSearchParams({ date })}` : "/api/food-counts");
}

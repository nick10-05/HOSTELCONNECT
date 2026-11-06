import { Router } from "express";
import { z } from "zod";
import { hostelToday } from "../lib/dates";
import { parseQuery } from "../lib/http";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { getFoodCounts } from "../services/food";

// GET /api/food-counts?date=YYYY-MM-DD&pollId=3 (design doc, sections 5 and 9): the owner's
// veg and non-veg counts for the cook, overall and per building. Without a date, India's
// today (decided on day 8). With pollId (day 9; the design doc's poll_id, named as our other
// filters), only students who answered "returned" to that poll. The design doc's
// building_id is left out: every answer already has each building (decided on day 8).
export const foodCountsQuerySchema = z.object({
  date: z.iso.date("must be a date written as YYYY-MM-DD").optional(),
  pollId: z.coerce.number().int().positive().optional(),
});

export type FoodRouteDeps = AuthDeps & { clock: () => Date };

export function foodRouter(deps: FoodRouteDeps): Router {
  const { db, clock } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");

  router.get("/food-counts", auth, isOwner, async (req, res) => {
    const query = parseQuery(foodCountsQuerySchema, req, res);
    if (!query) return;
    // Counts change with every admission and move: the browser must always ask again.
    res.set("Cache-Control", "no-store");
    res.json(await getFoodCounts(db, query.date ?? hostelToday(clock()), query.pollId ?? null));
  });

  return router;
}

import { Router } from "express";
import { hostelToday } from "../lib/dates";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { getDashboard } from "../services/dashboard";

// GET /api/dashboard (design doc, sections 5 and 9): every card of the owner's home page
// in one answer.
export function dashboardRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");

  router.get("/dashboard", auth, isOwner, async (_req, res) => {
    // Counts change with every admission and request: the browser must always ask again.
    res.set("Cache-Control", "no-store");
    res.json(await getDashboard(db, hostelToday()));
  });

  return router;
}

import { Router } from "express";
import { hostelToday } from "../lib/dates";
import type { PhotoStorage } from "../lib/storage";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { getDashboard } from "../services/dashboard";
import { getUsage, type UsageLimits } from "../services/usage";

// The storage and bandwidth card (day 8) needs the usage guard's limits, whether photo
// storage is set up at all, and the clock the egress month is read from.
export type DashboardRouteDeps = AuthDeps & {
  storage: PhotoStorage | null;
  usageLimits: UsageLimits;
  clock: () => Date;
};

// GET /api/dashboard (design doc, sections 5 and 9): every card of the owner's home page
// in one answer. `usage` (day 8, section 10) is getUsage as it is, plus photosConfigured:
// false when Supabase Storage is not set up, so the card can tell "not set up" from
// "switched off by the guard".
export function dashboardRouter(deps: DashboardRouteDeps): Router {
  const { db, storage, usageLimits, clock } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");

  router.get("/dashboard", auth, isOwner, async (_req, res) => {
    // Counts change with every admission and request: the browser must always ask again.
    res.set("Cache-Control", "no-store");
    const now = clock();
    const [dashboard, usage] = await Promise.all([
      getDashboard(db, hostelToday(now)),
      getUsage(db, usageLimits, now),
    ]);
    res.json({ ...dashboard, usage: { ...usage, photosConfigured: storage !== null } });
  });

  return router;
}

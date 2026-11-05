import { Router } from "express";
import { z } from "zod";
import { idParam, parseQuery } from "../lib/http";
import { requireAuth, type AuthDeps } from "../middleware/auth";
import { listNotifications, markAllRead, markRead } from "../services/notifications";

// The bell (design doc, sections 5 and 9): every signed-in person, owner or student,
// reads and marks only their own notifications. The person always comes from the
// session, never from the request, so nobody can name someone else's.

export const notificationListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function notificationsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);

  // Polled about once a minute while the app is open.
  router.get("/notifications", auth, async (req, res) => {
    const query = parseQuery(notificationListSchema, req, res);
    if (!query) return;
    res.json(await listNotifications(db, req.user!.id, query));
  });

  // Before /:id/read only for readability: the paths cannot match each other.
  router.post("/notifications/read-all", auth, async (req, res) => {
    res.json({ marked: await markAllRead(db, req.user!.id) });
  });

  router.post("/notifications/:id/read", auth, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await markRead(db, req.user!.id, id);
    res.status(204).end();
  });

  return router;
}

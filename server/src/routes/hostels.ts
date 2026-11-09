import { Router } from "express";
import type { Db } from "../db";
import { sendError } from "../lib/http";
import { activeHostelBySlug } from "../services/hostels";

// A hostel's public page, /h/<slug>/ (multi-tenant phase 3a): the sign-in page asks which
// hostel the address belongs to, to show its name. Only the name and the address: the
// rest of a hostel is for the people signed in to it.
export function hostelsRouter({ db }: { db: Db }): Router {
  const router = Router();

  router.get("/hostels/:slug", async (req, res) => {
    const hostel = await activeHostelBySlug(db, req.params.slug);
    if (!hostel) {
      sendError(res, 404, "hostel_not_found", "No hostel has this address.");
      return;
    }
    res.json({ hostel: { name: hostel.name, slug: hostel.slug } });
  });

  return router;
}

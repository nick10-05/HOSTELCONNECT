import { Router } from "express";
import { z } from "zod";
import { addDays, hostelToday } from "../lib/dates";
import { parseBody, sendError } from "../lib/http";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { activeHostelBySlug, getHostelSettings, updateHostelProfile } from "../services/hostels";

// The earliest fees start date an owner may set: fee rows go back to it, so not further
// than a hostel could have records for. The latest is a year from today.
const EARLIEST_FEES_START = "2020-01-01";

// The owner's changes to their hostel (phase 4a): its name, and its address. Changing the
// address changes every student's sign-in link; the page says so before saving. Phase 5a
// adds the day fees start: fee rows are created for due dates from then on.
const profileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "is required")
      .max(100, "can be at most 100 characters")
      .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
      .optional(),
    slug: z.string().trim().toLowerCase().optional(),
    feesStartDate: z.iso
      .date("must be a date written as YYYY-MM-DD")
      .refine((d) => d >= EARLIEST_FEES_START, `must be ${EARLIEST_FEES_START} or later`)
      .refine((d) => d <= addDays(hostelToday(), 366), "must be within a year from today")
      .optional(),
  })
  .refine((b) => b.name !== undefined || b.slug !== undefined || b.feesStartDate !== undefined, "nothing to change");

// A hostel's public page, /h/<slug>/ (multi-tenant phase 3a): the sign-in page asks which
// hostel the address belongs to, to show its name. Only the name and the address: the
// rest of a hostel is for the people signed in to it.
export function hostelsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const inHostel = hostelWork(db);
  const router = Router();

  // GET /api/hostel: the signed-in owner's own hostel, with its fees start date, limits
  // and how much of them is used (phase 5a).
  router.get("/hostel", requireAuth(deps), requireRole("owner"), async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ hostel: await inHostel(req, getHostelSettings) });
  });

  // PATCH /api/hostel: the signed-in owner's own hostel, never another (withHostel).
  router.patch("/hostel", requireAuth(deps), requireRole("owner"), async (req, res) => {
    const body = parseBody(profileSchema, req, res);
    if (!body) return;
    res.json({ hostel: await inHostel(req, (tx) => updateHostelProfile(tx, body)) });
  });

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

import { Router } from "express";
import { z } from "zod";
import { idParam, parseBody, parseQuery } from "../lib/http";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import {
  deleteAnnouncement,
  listAnnouncements,
  postAnnouncement,
  updateAnnouncement,
} from "../services/announcements";

// Announcements (design doc, sections 5 and 9): everyone signed in reads them; only the
// owner posts, edits, pins, marks urgent and deletes. Posting notifies every active
// student; editing never notifies again (services/announcements.ts). Announcements hold
// no personal data, so their answers may be cached like any other.

// Characters as the database counts them (code points): an emoji is one, not two.
const characters = (s: string) => [...s].length;

// Trimmed first, then 1 to `max` characters, as migration 010 checks them.
const text = (max: number) =>
  z
    .string()
    .trim()
    // Postgres text cannot hold a NUL character; refuse it here rather than fail later.
    .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
    .refine((s) => characters(s) >= 1, "must not be empty")
    .refine((s) => characters(s) <= max, `can be at most ${max} characters`);

// POST /api/announcements.
export const newAnnouncementSchema = z.object({
  title: text(120),
  body: text(2000),
  isUrgent: z.boolean().default(false),
  isPinned: z.boolean().default(false),
});

// PATCH /api/announcements/:id: any of the four fields, at least one; nothing else, so the
// author and the creation time can never be sent (decided on day 7).
export const announcementChangesSchema = z
  .strictObject({
    title: text(120).optional(),
    body: text(2000).optional(),
    isUrgent: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  })
  .refine((changes) => Object.values(changes).some((v) => v !== undefined), "nothing to change");

export const announcementListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function announcementsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const inHostel = hostelWork(db);

  // Pinned first, then newest; the same list for the owner and the students.
  router.get("/announcements", auth, async (req, res) => {
    const query = parseQuery(announcementListSchema, req, res);
    if (!query) return;
    res.json(await inHostel(req, (tx) => listAnnouncements(tx, query)));
  });

  router.post("/announcements", auth, isOwner, async (req, res) => {
    const body = parseBody(newAnnouncementSchema, req, res);
    if (!body) return;
    res.status(201).json(await inHostel(req, (tx) => postAnnouncement(tx, req.user!.id, body)));
  });

  router.patch("/announcements/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(announcementChangesSchema, req, res);
    if (!body) return;
    res.json(await inHostel(req, (tx) => updateAnnouncement(tx, id, body)));
  });

  // The screen asks "are you sure?" first (section 8); the API just deletes.
  router.delete("/announcements/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await inHostel(req, (tx) => deleteAnnouncement(tx, id));
    res.status(204).end();
  });

  return router;
}

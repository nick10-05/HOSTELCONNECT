import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { idParam, parseBody, parseQuery, sendError } from "../lib/http";
import { detectPhotoType } from "../lib/photoType";
import type { PhotoStorage } from "../lib/storage";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { photoUpload } from "../middleware/photoUpload";
import { getComplaintPhoto, photoView, studentPhotoView } from "../services/photos";
import { getUsage, type UsageLimits } from "../services/usage";
import {
  COMPLAINT_CATEGORIES,
  addComplaintNote,
  changeComplaintStatus,
  createComplaint,
  getMyComplaint,
  getOwnerComplaint,
  getRaiseStatus,
  listMyComplaints,
  listOwnerComplaints,
  setComplaintPriority,
  type ComplaintLimits,
  type OwnerComplaintFilters,
} from "../services/complaints";

// Complaints (design doc, sections 5, 6, 8 and 9). A student raises a text complaint and
// reads their own (day 6); the owner reads everyone's (day 7). GET /api/complaints and
// /api/complaints/:id answer by role, so each side gets its own version: the student's
// never shows the priority. The student always comes from the session, never from the
// request, so nobody can raise or read a complaint as someone else.

// Decided on day 6. Section 8 asks for a per-IP limit on complaint creation but gives no
// number. Students share the hostel's Wi-Fi, so many of them can arrive from one IP:
// only refused requests count (as with the login limit), and a complaint that is
// accepted never uses up the limit. A burst of real complaints from one IP is therefore
// never blocked, while someone hammering the endpoint is. Counted in this server's
// memory, so the counts reset when the free server sleeps or restarts.
export const COMPLAINT_REFUSALS_PER_IP = 20; // per 15 minutes

// Characters as the database counts them (code points). JavaScript's length counts an
// emoji as 2, which would let 5 emoji pass a 10-character minimum that the database
// then refuses, a 500 instead of a 400.
const characters = (s: string) => [...s].length;

// The body of POST /api/complaints: JSON, or since day 8 multipart form data with the
// optional photo (the same two text fields). The description is trimmed first and must
// then be 10 to 500 characters, as migration 009 checks it (decided on day 6).
export const newComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES, "must be one of the listed categories"),
  description: z
    .string()
    .trim()
    // Postgres text cannot hold a NUL character; refuse it here rather than fail later.
    .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
    .refine((s) => characters(s) >= 10, "must be at least 10 characters")
    .refine((s) => characters(s) <= 500, "can be at most 500 characters"),
});

export const complaintListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// The owner's list: GET /api/complaints?status=open&buildingId=2&from=2026-11-01&page=2.
// Every filter is optional. buildingId is named as in the student directory's query.
// from and to are India's dates, both included; from after to is refused.
const dateText = z.iso.date("must be a date written as YYYY-MM-DD");
export const ownerComplaintListSchema = complaintListSchema
  .extend({
    status: z.enum(["open", "in_progress", "resolved", "rejected"]).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    category: z.enum(COMPLAINT_CATEGORIES, "must be one of the listed categories").optional(),
    buildingId: z.coerce.number().int().positive().optional(),
    from: dateText.optional(),
    to: dateText.optional(),
  })
  // 'YYYY-MM-DD' text compares like the dates it holds.
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "must not be after to", path: ["from"] })
  .transform(
    (q): OwnerComplaintFilters => ({
      status: q.status ?? null,
      priority: q.priority ?? null,
      category: q.category ?? null,
      buildingId: q.buildingId ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      page: q.page,
      limit: q.limit,
    }),
  );

// ---- The owner's writes (day 7) ----
// Shape and types only. The services keep every rule (legal moves, blank or long notes,
// a complaint that changed meanwhile), so the owner always sees their exact messages.
const STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;
// Postgres text cannot hold a NUL character; refuse it here rather than fail later.
const noteText = z.string().refine((s) => !s.includes("\u0000"), "contains a character that is not allowed");

// POST /api/complaints/:id/status. `from` is the status the owner's screen showed.
export const statusChangeSchema = z.object({
  from: z.enum(STATUSES),
  to: z.enum(STATUSES),
  note: noteText.nullable().optional(),
});

// PATCH /api/complaints/:id sets the priority and nothing else (decided on day 7): any
// other field, status included, is refused, because a status change is an action with
// its own route (section 5), not a field edit.
export const priorityChangeSchema = z.strictObject({
  priority: z.enum(["low", "normal", "high"]),
});

// POST /api/complaints/:id/notes.
export const noteSchema = z.object({ note: noteText });

// The photo settings (day 8): storage (null: uploads off), PHOTO_MAX_BYTES,
// PHOTO_LINK_SECONDS, the usage guard's limits, and the clock the guard and the photo's
// expiry are read against.
export type ComplaintsRouteDeps = AuthDeps & {
  limits: ComplaintLimits;
  storage: PhotoStorage | null;
  photoMaxBytes: number;
  photoLinkSeconds: number;
  usageLimits: UsageLimits;
  clock: () => Date;
};

// Rate-limit counters are created per router, so every app (and every test) has its own.
export function complaintsRouter(deps: ComplaintsRouteDeps): Router {
  const { db, limits, storage, photoMaxBytes, photoLinkSeconds, usageLimits, clock } = deps;

  // The photo as the detail pages show it (day 8): only after the complaint itself has
  // been found for this reader, so a link is never issued for someone else's complaint.
  // Every call may issue a link, which counts as egress, so only the detail answers ask
  // for it: not the lists, and not the create answer (the form then opens the detail).
  const photoFor = async (complaintId: number) =>
    photoView(db, storage, await getComplaintPhoto(db, complaintId), { now: clock(), seconds: photoLinkSeconds });
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isStudent = requireRole("student");
  const isOwner = requireRole("owner");

  const refusalsPerIp = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: COMPLAINT_REFUSALS_PER_IP,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, 429, "rate_limited", "Too many refused complaints from here. Please try again later."),
  });

  // After the session and role checks, so only students' requests are counted, and only
  // students' uploads are read. The text is checked before the photo's type, and both
  // before anything is stored.
  router.post("/complaints", auth, isStudent, refusalsPerIp, photoUpload(photoMaxBytes), async (req, res) => {
    const body = parseBody(newComplaintSchema, req, res);
    if (!body) return;
    let photo = null;
    if (req.file) {
      const type = detectPhotoType(req.file.buffer);
      if (!type) {
        sendError(res, 400, "photo_type", "The photo must be a JPEG, PNG or WebP image.");
        return;
      }
      photo = { bytes: req.file.buffer, type };
    }
    const { id } = await createComplaint(db, req.user!.id, { ...body, photo }, limits, {
      storage,
      usageLimits,
      now: clock(),
    });
    res.status(201).json(await getMyComplaint(db, req.user!.id, id));
  });

  // The owner: every complaint, filtered and in section 5's order. A student: their own
  // list, plus whether they can raise a complaint now (section 9: the button is disabled
  // with the reason shown), so the home page needs one request; and whether the form may
  // offer a photo (day 8). Like canRaise, a hint: createComplaint checks again.
  router.get("/complaints", auth, async (req, res) => {
    if (req.user!.role === "owner") {
      const query = parseQuery(ownerComplaintListSchema, req, res);
      if (!query) return;
      // Student names in the answer: no browser or proxy may keep a copy.
      res.set("Cache-Control", "no-store");
      res.json(await listOwnerComplaints(db, query));
      return;
    }
    const query = parseQuery(complaintListSchema, req, res);
    if (!query) return;
    const [list, canRaise, photoUploadsAllowed] = await Promise.all([
      listMyComplaints(db, req.user!.id, query),
      getRaiseStatus(db, req.user!.id, limits),
      storage ? getUsage(db, usageLimits, clock()).then((usage) => usage.uploadsAllowed) : false,
    ]);
    res.json({ ...list, canRaise, photoUploadsAllowed });
  });

  // The owner: any complaint, with its priority, the moves allowed now and the photo's
  // countdown. A student: another student's complaint is a 404, the same as one that does
  // not exist; their own photo comes without the expiry time. Both answers may hold a
  // signed link: no browser or proxy may keep a copy.
  router.get("/complaints/:id", auth, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.set("Cache-Control", "no-store");
    if (req.user!.role === "owner") {
      const detail = await getOwnerComplaint(db, id);
      res.json({ ...detail, photo: await photoFor(id) });
      return;
    }
    const detail = await getMyComplaint(db, req.user!.id, id);
    res.json({ ...detail, photo: studentPhotoView(await photoFor(id)) });
  });

  // The owner's writes. Each answers with the owner's view of the complaint afterwards,
  // photo included, so the screen redraws from it. Student names and a signed link are
  // in it: no browser or proxy may keep a copy.
  router.post("/complaints/:id/status", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(statusChangeSchema, req, res);
    if (!body) return;
    const detail = await changeComplaintStatus(db, req.user!.id, id, body);
    res.set("Cache-Control", "no-store");
    res.json({ ...detail, photo: await photoFor(id) });
  });

  router.patch("/complaints/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(priorityChangeSchema, req, res);
    if (!body) return;
    const detail = await setComplaintPriority(db, id, body.priority);
    res.set("Cache-Control", "no-store");
    res.json({ ...detail, photo: await photoFor(id) });
  });

  router.post("/complaints/:id/notes", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(noteSchema, req, res);
    if (!body) return;
    const detail = await addComplaintNote(db, req.user!.id, id, body.note);
    res.set("Cache-Control", "no-store");
    res.json({ ...detail, photo: await photoFor(id) });
  });

  return router;
}

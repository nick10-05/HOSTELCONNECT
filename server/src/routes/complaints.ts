import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { idParam, parseBody, parseQuery, sendError } from "../lib/http";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import {
  COMPLAINT_CATEGORIES,
  createComplaint,
  getMyComplaint,
  getRaiseStatus,
  listMyComplaints,
  type ComplaintLimits,
} from "../services/complaints";

// Student complaints (design doc, sections 5, 6, 8 and 9). Day 6: a student raises a text
// complaint and reads their own. The owner's list, status changes, priority and notes
// arrive on day 7, so for now these routes are for students only and the owner gets 403.
// The student always comes from the session, never from the request, so nobody can raise
// or read a complaint as someone else.

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

// The body of POST /api/complaints. JSON on day 6; it becomes multipart with the optional
// photo on day 8. The description is trimmed first and must then be 10 to 500
// characters, as migration 009 checks it (decided on day 6).
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

export type ComplaintsRouteDeps = AuthDeps & { limits: ComplaintLimits };

// Rate-limit counters are created per router, so every app (and every test) has its own.
export function complaintsRouter(deps: ComplaintsRouteDeps): Router {
  const { db, limits } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isStudent = requireRole("student");

  const refusalsPerIp = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: COMPLAINT_REFUSALS_PER_IP,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, 429, "rate_limited", "Too many refused complaints from here. Please try again later."),
  });

  // After the session and role checks, so only students' requests are counted.
  router.post("/complaints", auth, isStudent, refusalsPerIp, async (req, res) => {
    const body = parseBody(newComplaintSchema, req, res);
    if (!body) return;
    const { id } = await createComplaint(db, req.user!.id, body, limits);
    res.status(201).json(await getMyComplaint(db, req.user!.id, id));
  });

  // The list, plus whether the student can raise a complaint now (section 9: the button
  // is disabled with the reason shown), so the home page needs one request.
  router.get("/complaints", auth, isStudent, async (req, res) => {
    const query = parseQuery(complaintListSchema, req, res);
    if (!query) return;
    const [list, canRaise] = await Promise.all([
      listMyComplaints(db, req.user!.id, query),
      getRaiseStatus(db, req.user!.id, limits),
    ]);
    res.json({ ...list, canRaise });
  });

  // Another student's complaint is a 404, the same as one that does not exist.
  router.get("/complaints/:id", auth, isStudent, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json(await getMyComplaint(db, req.user!.id, id));
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { hostelToday } from "../lib/dates";
import { idParam, parseBody, parseQuery } from "../lib/http";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { getMyFees, listFees, markFee } from "../services/fees";

// Fees (design doc, sections 5 and 9): the owner's list for a month, marking a fee paid or
// pending again, and a student's own fees. "Today" is always India's date (hostelToday), so
// a fee is overdue, and a payment date is "not after today", by the hostel's calendar. Fee
// rows are personal and change at any moment, so no answer here may be cached.

// Characters as the database counts them (code points): an emoji is one, not two.
const characters = (s: string) => [...s].length;

// GET /api/fees?month=1997-07&status=overdue&buildingId=2&page=1&limit=20. Without a month,
// India's current month. The design doc's building_id, named buildingId as in the other
// filters.
export const feeListSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month written as YYYY-MM")
    .optional(),
  status: z.enum(["paid", "pending", "overdue"]).optional(),
  buildingId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// The owner's note on a payment: trimmed, then at most 200 characters, as migration 012
// checks it. Blank or missing means no note.
const feeNote = z
  .string()
  .trim()
  // Postgres text cannot hold a NUL character; refuse it here rather than fail later.
  .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
  .refine((s) => characters(s) <= 200, "can be at most 200 characters")
  .transform((s) => (s === "" ? null : s));

// POST /api/fees/:id/status. Paid: paidOn defaults to India's today (the service refuses a
// later date). Pending (an undo): nothing else may be sent, since the service clears the
// payment date and note.
export const feeStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("paid"),
    paidOn: z.iso.date("must be a date written as YYYY-MM-DD").optional(),
    note: feeNote.nullable().optional(),
  }),
  z.strictObject({ status: z.literal("pending") }),
]);

export type FeesRouteDeps = AuthDeps & { clock: () => Date };

export function feesRouter(deps: FeesRouteDeps): Router {
  const { db, clock } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const isStudent = requireRole("student");

  router.get("/fees", auth, isOwner, async (req, res) => {
    const query = parseQuery(feeListSchema, req, res);
    if (!query) return;
    const today = hostelToday(clock());
    res.set("Cache-Control", "no-store");
    res.json(
      await listFees(
        db,
        {
          month: query.month ?? today.slice(0, 7),
          status: query.status ?? null,
          buildingId: query.buildingId ?? null,
          page: query.page,
          limit: query.limit,
        },
        today,
      ),
    );
  });

  // Before /fees/:id/..., although the paths cannot clash; kept next to the list for reading.
  router.get("/fees/mine", auth, isStudent, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await getMyFees(db, req.user!.id, hostelToday(clock())));
  });

  router.post("/fees/:id/status", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(feeStatusSchema, req, res);
    if (!body) return;
    const today = hostelToday(clock());
    const change =
      body.status === "paid"
        ? { status: "paid" as const, paidOn: body.paidOn ?? today, note: body.note ?? null }
        : { status: "pending" as const };
    res.json(await markFee(db, id, req.user!.id, change, today));
  });

  return router;
}

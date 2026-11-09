import { Router } from "express";
import { z } from "zod";
import { addDays, hostelToday } from "../lib/dates";
import { idParam, parseBody, parseQuery } from "../lib/http";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import * as students from "../services/students";

// Owner-only student endpoints. This file checks who is asking and what they sent, and
// turns the form into the clean shape the service expects; the rules live in
// services/students.ts.

// A joining date may be up to this many days ahead, for a student who books before
// arriving. Earlier dates have no limit: the import uses real past joining dates.
export const MAX_DAYS_AHEAD = 30;

const text = (max: number) => z.string().trim().min(1, "is required").max(max);

// An Indian mobile number: 10 digits starting with 6 to 9, optionally written with +91
// and spaces or dashes. Stored as the 10 digits only, so the same number always looks
// the same in the database.
const mobile = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .refine((s) => /^(\+91)?[6-9]\d{9}$/.test(s), "must be a 10-digit Indian mobile number")
  .transform((s) => s.slice(-10));

const id = z.number().int().positive();

// A student's details, without where they live. Shared by the admission form below and
// the CSV import (scripts/importStudents.ts), so both apply exactly the same rules.
const detailsObject = z.object({
  name: text(100),
  // Lower case, so the address shows the same way everywhere; login ignores case anyway.
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("must be a valid email address")),
  phone: mobile,
  parentPhone: mobile,
  category: z.enum(["college", "working", "other"]),
  collegeName: text(100).optional(),
  branch: text(100).optional(),
  academicYear: z.number().int().min(1).max(6).optional(),
  company: text(100).optional(),
  designation: text(100).optional(),
  // z.iso.date() also refuses days that do not exist, such as 2026-02-30.
  joiningDate: z.iso.date("must be a date written as YYYY-MM-DD"),
  foodPreference: z.enum(["veg", "non_veg"]),
  // Weekdays a non-veg student eats veg: 1 = Monday ... 7 = Sunday (migration 006).
  vegDays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  // Rupees; left out or null means "not set yet".
  monthlyFee: z.number().int().min(0).max(1_000_000).nullable().default(null),
  // Under 18 (phase 5b): only with the owner's confirmation of a parent's or guardian's
  // consent, which the app records.
  under18: z.boolean().default(false),
  guardianConsent: z.boolean().default(false),
});

type Details = z.infer<typeof detailsObject>;
export type StudentDetails = Omit<students.AdmissionInput, "buildingId" | "roomId" | "bedId">;

// The edit form has no joining date (it cannot be changed after admission), so the rules
// below take one only when there is one.
type EditDetails = Omit<Details, "joiningDate">;

// The rules that span several fields.
function checkDetails(v: EditDetails & { joiningDate?: string }, ctx: z.RefinementCtx): void {
  const missing = (path: string) => ctx.addIssue({ code: "custom", path: [path], message: "is required" });
  if (v.category === "college") {
    if (!v.collegeName) missing("collegeName");
    if (!v.branch) missing("branch");
    if (v.academicYear === undefined) missing("academicYear");
  }
  if (v.category === "working" && !v.company) missing("company");
  if (new Set(v.vegDays).size !== v.vegDays.length) {
    ctx.addIssue({ code: "custom", path: ["vegDays"], message: "lists a day twice" });
  }
  if (v.under18 && !v.guardianConsent) {
    ctx.addIssue({
      code: "custom",
      path: ["guardianConsent"],
      message: "must be confirmed for a student under 18",
    });
  }
  if (v.vegDays.length > 0 && v.foodPreference !== "non_veg") {
    ctx.addIssue({ code: "custom", path: ["vegDays"], message: "are only for non-veg students" });
  }
  // Checked when the request arrives, against India's date.
  if (v.joiningDate !== undefined && v.joiningDate > addDays(hostelToday(), MAX_DAYS_AHEAD)) {
    ctx.addIssue({
      code: "custom",
      path: ["joiningDate"],
      message: `can be at most ${MAX_DAYS_AHEAD} days from today`,
    });
  }
}

// Keep only the fields that belong to the chosen category, so a form that still holds
// a college name after switching to "working" does not store it.
const pickEdit = (v: EditDetails): students.StudentEdit => ({
  name: v.name,
  email: v.email,
  phone: v.phone,
  parentPhone: v.parentPhone,
  category: v.category,
  collegeName: v.category === "college" ? v.collegeName! : null,
  branch: v.category === "college" ? v.branch! : null,
  academicYear: v.category === "college" ? v.academicYear! : null,
  company: v.category === "working" ? v.company! : null,
  designation: v.category === "working" ? (v.designation ?? null) : null,
  foodPreference: v.foodPreference,
  vegDays: [...v.vegDays].sort((a, b) => a - b),
  monthlyFee: v.monthlyFee,
  under18: v.under18,
});

const pickDetails = (v: Details): StudentDetails => ({ ...pickEdit(v), joiningDate: v.joiningDate });

export const studentDetailsSchema = detailsObject.superRefine(checkDetails).transform(pickDetails);

// Editing a student (PATCH /api/students/:id): the same details and rules, without the
// joining date or the place. Strict, so a joining date or a building sent anyway is a 400,
// not silently ignored.
export const studentEditSchema = detailsObject
  .omit({ joiningDate: true })
  .strict()
  .superRefine(checkDetails)
  .transform(pickEdit);

export const admissionSchema = detailsObject
  .extend({
    buildingId: id,
    // Room and bed are optional: only offered once the owner has built that level.
    roomId: id.nullable().default(null),
    bedId: id.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    checkDetails(v, ctx);
    if (v.bedId !== null && v.roomId === null) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "is required when a bed is chosen" });
    }
  })
  .transform(
    (v): students.AdmissionInput => ({
      ...pickDetails(v),
      buildingId: v.buildingId,
      roomId: v.roomId,
      bedId: v.bedId,
    }),
  );

// Where a transfer moves the student to (POST /api/students/:id/transfer). Room and bed
// are optional, as at admission; the service decides between a transfer and, for a stay
// that has not started, a reassignment in place.
export const transferSchema = z
  .object({
    buildingId: id,
    roomId: id.nullable().default(null),
    bedId: id.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.bedId !== null && v.roomId === null) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "is required when a bed is chosen" });
    }
  });

// A former student coming back (POST /api/students/:id/reactivate): the new joining date,
// under the admission rule, and where they will live. Whether the date is on or after
// the day they left is the service's check, since it needs the database.
export const reactivationSchema = z
  .object({
    joiningDate: z.iso.date("must be a date written as YYYY-MM-DD"),
    buildingId: id,
    roomId: id.nullable().default(null),
    bedId: id.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.joiningDate > addDays(hostelToday(), MAX_DAYS_AHEAD)) {
      ctx.addIssue({
        code: "custom",
        path: ["joiningDate"],
        message: `can be at most ${MAX_DAYS_AHEAD} days from today`,
      });
    }
    if (v.bedId !== null && v.roomId === null) {
      ctx.addIssue({ code: "custom", path: ["roomId"], message: "is required when a bed is chosen" });
    }
  });

// The directory's query string: GET /api/students?search=asha&buildingId=2&page=2.
// Everything arrives as text. Phone numbers are not searchable: a search goes into the
// address, and phone numbers never go in URLs (they end up in history and host logs).
const optionalId = z.coerce.number().int().positive().optional();
export const directorySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    buildingId: optionalId,
    floorId: optionalId,
    roomId: optionalId,
    category: z.enum(["college", "working", "other"]).optional(),
    // Active students unless asked otherwise; "all" includes former students.
    status: z.enum(["active", "former", "all"]).default("active"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .transform(
    (q): students.StudentFilters => ({
      search: q.search || null,
      buildingId: q.buildingId ?? null,
      floorId: q.floorId ?? null,
      roomId: q.roomId ?? null,
      category: q.category ?? null,
      active: q.status === "all" ? null : q.status === "active",
      page: q.page,
      limit: q.limit,
    }),
  );

export function studentsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in routes/structure.ts, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const inHostel = hostelWork(db);

  router.get("/students", auth, isOwner, async (req, res) => {
    const query = parseQuery(directorySchema, req, res);
    if (!query) return;
    res.json(await inHostel(req, (tx) => students.listStudents(tx, query)));
  });

  router.get("/students/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    // Phone numbers are in this answer: no browser or proxy may keep a copy.
    res.set("Cache-Control", "no-store");
    res.json({ student: await inHostel(req, (tx) => students.getStudent(tx, id, hostelToday())) });
  });

  router.patch("/students/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(studentEditSchema, req, res);
    if (!body) return;
    const student = await inHostel(req, async (tx) => {
      await students.updateStudent(tx, id, body, req.user!.id);
      return students.getStudent(tx, id, hostelToday());
    });
    // The profile as it is now. Phone numbers are in it: no browser or proxy may keep a copy.
    res.set("Cache-Control", "no-store");
    res.json({ student });
  });

  router.post("/students", auth, isOwner, async (req, res) => {
    const body = parseBody(admissionSchema, req, res);
    if (!body) return;
    const result = await inHostel(req, (tx) => students.admitStudent(tx, req.user!.id, body));
    // The answer carries the temporary password, shown once: no browser or proxy may keep it.
    res.set("Cache-Control", "no-store");
    res.status(201).json(result);
  });

  router.post("/students/:id/transfer", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(transferSchema, req, res);
    if (!body) return;
    const transfer = await inHostel(req, (tx) => students.transferStudent(tx, req.user!.id, id, body, hostelToday()));
    res.json({ transfer });
  });

  router.post("/students/:id/deactivate", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await inHostel(req, (tx) => students.deactivateStudent(tx, id, hostelToday()));
    res.status(204).end();
  });

  router.post("/students/:id/reset-password", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const result = await inHostel(req, (tx) => students.resetStudentPassword(tx, id));
    // The answer carries the temporary password, shown once: no browser or proxy may keep it.
    res.set("Cache-Control", "no-store");
    res.json(result);
  });

  router.post("/students/:id/reactivate", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(reactivationSchema, req, res);
    if (!body) return;
    const result = await inHostel(req, (tx) => students.reactivateStudent(tx, req.user!.id, id, body));
    // The answer carries the temporary password, shown once: no browser or proxy may keep it.
    res.set("Cache-Control", "no-store");
    res.json(result);
  });

  return router;
}

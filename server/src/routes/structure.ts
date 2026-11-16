import { rateLimit } from "express-rate-limit";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { HttpError, idParam, parseBody, sendError } from "../lib/http";
import { maskEmail, type Mailer } from "../lib/mailer";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import * as structure from "../services/structure";
import * as deletion from "../services/structureDeletion";

// Owner-only endpoints for buildings, floors, rooms and beds. This file only checks
// who is asking and what they sent; the rules live in services/structure.ts.

const name = (max: number) => z.string().trim().min(1, "is required").max(max);

const buildingSchema = z.object({ name: name(100) });
// 0 = ground floor (migration 003).
const floorSchema = z.object({ number: z.number().int().min(0).max(99) });
const roomSchema = z.object({
  roomNumber: name(20),
  // Left out or null: the room sits straight under the building.
  floorId: z.number().int().positive().nullable().default(null),
});
const bedSchema = z.object({ bedNumber: name(10) });
// Deleting a building or room (services/structureDeletion.ts): the typed name, then the code.
const confirmSchema = z.object({ confirmName: z.string().max(100) });
const deleteSchema = confirmSchema.extend({
  codeId: z.uuid("is not a code id"),
  code: z.string().regex(/^\d{6}$/, "must be the 6 digits from the email"),
});

// Per address, on top of the per-owner limits in the service (which survive a restart).
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "too_many_requests", "Too many tries from here. Try again in 15 minutes."),
  });

export type StructureRouteDeps = AuthDeps & {
  // Sends the deletion codes (lib/mailer.ts); null: deleting buildings and rooms is off.
  mailer?: Mailer | null;
};

export function structureRouter(deps: StructureRouteDeps): Router {
  const { db, mailer = null } = deps;
  const key = deletion.deletionCodeKey(deps.jwtSecret);
  const codeLimiter = limiter(10);
  const deleteLimiter = limiter(30);
  const router = Router();
  // Applied per route rather than with router.use, so unknown /api paths still get
  // the plain 404 instead of a 401.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const inHostel = hostelWork(db);

  router.get("/structure", auth, isOwner, async (req, res) => {
    res.json({ buildings: await inHostel(req, (tx) => structure.listStructure(tx)) });
  });

  router.post("/buildings", auth, isOwner, async (req, res) => {
    const body = parseBody(buildingSchema, req, res);
    if (!body) return;
    res.status(201).json({ building: await inHostel(req, (tx) => structure.createBuilding(tx, body.name)) });
  });

  router.post("/buildings/:id/floors", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(floorSchema, req, res);
    if (!body) return;
    res.status(201).json({ floor: await inHostel(req, (tx) => structure.addFloor(tx, id, body.number)) });
  });

  router.delete("/floors/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await inHostel(req, (tx) => structure.deleteFloor(tx, id));
    res.status(204).end();
  });

  router.post("/buildings/:id/rooms", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(roomSchema, req, res);
    if (!body) return;
    res.status(201).json({ room: await inHostel(req, (tx) => structure.addRoom(tx, id, body)) });
  });

  router.post("/rooms/:id/beds", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(bedSchema, req, res);
    if (!body) return;
    res.status(201).json({ bed: await inHostel(req, (tx) => structure.addBed(tx, id, body.bedNumber)) });
  });

  router.post("/beds/:id/retire", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json({ bed: await inHostel(req, (tx) => structure.retireBed(tx, id)) });
  });

  router.post("/beds/:id/reactivate", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json({ bed: await inHostel(req, (tx) => structure.reactivateBed(tx, id)) });
  });

  // ---- Deleting a building or room, with an email code ----

  const noEmail = (res: Response) =>
    sendError(res, 503, "email_not_set_up", "Deleting needs a code sent by email, and email is not set up on this server yet.");

  for (const [kind, path] of [["building", "buildings"], ["room", "rooms"]] as const) {
    // What deleting it would take along, for the confirm screen.
    router.get(`/${path}/:id/deletion`, auth, isOwner, async (req, res) => {
      const id = idParam(req, res);
      if (id === undefined) return;
      const preview = await inHostel(req, (tx) => deletion.previewDeletion(tx, kind, id));
      res.json({ deletion: { ...preview, emailReady: mailer !== null } });
    });

    // Step 1: checks the typed name, makes a code and emails it.
    router.post(`/${path}/:id/delete-code`, auth, isOwner, codeLimiter, async (req, res) => {
      const id = idParam(req, res);
      if (id === undefined) return;
      const body = parseBody(confirmSchema, req, res);
      if (!body) return;
      if (!mailer) return noEmail(res);
      const issued = await inHostel(req, (tx) =>
        deletion.requestDeletionCode(tx, { ownerId: req.user!.id, kind, id, confirmName: body.confirmName, key }),
      );
      // After the code is committed, outside the transaction: a slow email service never
      // holds the locks. A failed send makes the code unusable.
      try {
        await mailer.send({ to: issued.ownerEmail, ...deletion.deletionEmail(issued) });
      } catch {
        await inHostel(req, (tx) => deletion.markCodeNotSent(tx, issued.codeId));
        sendError(res, 502, "email_failed", "We could not send the code. Try again in a moment.");
        return;
      }
      res.status(201).json({
        code: {
          codeId: issued.codeId,
          expiresAt: issued.expiresAt,
          resendAfterSeconds: issued.resendAfterSeconds,
          sentTo: maskEmail(issued.ownerEmail),
        },
      });
    });

    // Step 2: the name again and the code; deletes for good.
    router.delete(`/${path}/:id`, auth, isOwner, deleteLimiter, async (req: Request, res: Response) => {
      const id = idParam(req, res);
      if (id === undefined) return;
      const body = parseBody(deleteSchema, req, res);
      if (!body) return;
      const result = await inHostel(req, (tx) =>
        deletion.deleteWithCode(tx, { ownerId: req.user!.id, kind, id, ...body, key }),
      );
      // The wrong try is already committed; only now is the refusal sent.
      if (!result.ok) {
        throw new HttpError(
          400,
          "wrong_code",
          result.attemptsLeft > 0
            ? `That code is not right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.`
            : "That code is not right, and it cannot be tried again. Ask for a new code.",
        );
      }
      res.json({ deleted: result.deleted });
    });
  }

  return router;
}

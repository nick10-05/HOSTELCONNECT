import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { parseBody, sendError } from "../lib/http";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import * as structure from "../services/structure";

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

// Route ids are positive whole numbers. Anything else cannot match a row, so it is a
// 404 like an unknown id, and the service never sees it.
function idParam(req: Request, res: Response): number | undefined {
  const raw = req.params.id;
  if (typeof raw === "string" && /^[1-9]\d{0,14}$/.test(raw)) return Number(raw);
  sendError(res, 404, "not_found", "No such item");
  return undefined;
}

export function structureRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Applied per route rather than with router.use, so unknown /api paths still get
  // the plain 404 instead of a 401.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");

  router.get("/structure", auth, isOwner, async (_req, res) => {
    res.json({ buildings: await structure.listStructure(db) });
  });

  router.post("/buildings", auth, isOwner, async (req, res) => {
    const body = parseBody(buildingSchema, req, res);
    if (!body) return;
    res.status(201).json({ building: await structure.createBuilding(db, body.name) });
  });

  router.delete("/buildings/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await structure.deleteBuilding(db, id);
    res.status(204).end();
  });

  router.post("/buildings/:id/floors", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(floorSchema, req, res);
    if (!body) return;
    res.status(201).json({ floor: await structure.addFloor(db, id, body.number) });
  });

  router.delete("/floors/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await structure.deleteFloor(db, id);
    res.status(204).end();
  });

  router.post("/buildings/:id/rooms", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(roomSchema, req, res);
    if (!body) return;
    res.status(201).json({ room: await structure.addRoom(db, id, body) });
  });

  router.delete("/rooms/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await structure.deleteRoom(db, id);
    res.status(204).end();
  });

  router.post("/rooms/:id/beds", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(bedSchema, req, res);
    if (!body) return;
    res.status(201).json({ bed: await structure.addBed(db, id, body.bedNumber) });
  });

  router.post("/beds/:id/retire", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json({ bed: await structure.retireBed(db, id) });
  });

  router.post("/beds/:id/reactivate", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json({ bed: await structure.reactivateBed(db, id) });
  });

  return router;
}

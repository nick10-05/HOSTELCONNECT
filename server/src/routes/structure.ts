import { Router } from "express";
import { z } from "zod";
import { idParam, parseBody } from "../lib/http";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
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

export function structureRouter(deps: AuthDeps): Router {
  const { db } = deps;
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

  router.delete("/buildings/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await inHostel(req, (tx) => structure.deleteBuilding(tx, id));
    res.status(204).end();
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

  router.delete("/rooms/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    await inHostel(req, (tx) => structure.deleteRoom(tx, id));
    res.status(204).end();
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

  return router;
}

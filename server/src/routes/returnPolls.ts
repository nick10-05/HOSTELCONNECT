import { Router } from "express";
import { z } from "zod";
import { idParam, parseBody, parseQuery } from "../lib/http";
import { requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import {
  answerPoll,
  closePoll,
  createPoll,
  getPollResults,
  listOpenPollsForStudent,
  listPolls,
} from "../services/returnPolls";

// Return polls (design doc, sections 5 and 9): the owner starts, closes and reads them;
// students see the open poll and answer it. Starting a poll notifies every active student
// (services/returnPolls.ts). Lists and results hold names and answers that change at any
// moment, so no answer here may be cached.

// Characters as the database counts them (code points): an emoji is one, not two.
const characters = (s: string) => [...s].length;

// POST /api/return-polls: the title trimmed, then 1 to 120 characters, as migration 012
// checks it.
export const newPollSchema = z.object({
  title: z
    .string()
    .trim()
    // Postgres text cannot hold a NUL character; refuse it here rather than fail later.
    .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
    .refine((s) => characters(s) >= 1, "must not be empty")
    .refine((s) => characters(s) <= 120, "can be at most 120 characters"),
});

// PUT /api/return-polls/:id/response.
export const pollResponseSchema = z.object({
  response: z.enum(["returned", "not_yet"]),
});

export const pollListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/return-polls/:id?buildingId=2. The design doc's building_id, named buildingId
// as in the complaint and student filters.
export const pollResultsSchema = z.object({
  buildingId: z.coerce.number().int().positive().optional(),
});

export function returnPollsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const isStudent = requireRole("student");

  // The owner: every poll, newest first, with counts. A student: the open poll with their
  // own answer (page and limit are checked but a student's list is at most one poll).
  router.get("/return-polls", auth, async (req, res) => {
    const query = parseQuery(pollListSchema, req, res);
    if (!query) return;
    res.set("Cache-Control", "no-store");
    if (req.user!.role === "owner") {
      res.json(await listPolls(db, query));
    } else {
      const items = await listOpenPollsForStudent(db, req.user!.id);
      res.json({ items, total: items.length });
    }
  });

  router.post("/return-polls", auth, isOwner, async (req, res) => {
    const body = parseBody(newPollSchema, req, res);
    if (!body) return;
    res.status(201).json(await createPoll(db, req.user!.id, body.title));
  });

  router.get("/return-polls/:id", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const query = parseQuery(pollResultsSchema, req, res);
    if (!query) return;
    res.set("Cache-Control", "no-store");
    res.json(await getPollResults(db, id, query.buildingId ?? null));
  });

  router.put("/return-polls/:id/response", auth, isStudent, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const body = parseBody(pollResponseSchema, req, res);
    if (!body) return;
    res.json(await answerPoll(db, id, req.user!.id, body.response));
  });

  router.post("/return-polls/:id/close", auth, isOwner, async (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    res.json(await closePoll(db, id));
  });

  return router;
}

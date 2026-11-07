import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Queryable } from "../src/db";
import { inRollback, insertOwner, testPool } from "./helpers/db";
import { asHostel } from "./helpers/hostels";
import { rollbackDb } from "./helpers/rollbackDb";

// Multi-tenant phase 2b-1, tested in 2c: run-jobs runs the jobs for every hostel in turn.
// A hostel whose jobs fail is logged and skipped, its work rolled back; the hostels after
// it still run; and the call answers 500 at the end, so GitHub reports the failed run.
// The digest job stands in for any failure: here it throws for one chosen hostel.
const failing = vi.hoisted(() => ({ hostel: 0 }));
vi.mock("../src/jobs/digest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/jobs/digest")>();
  return {
    ...actual,
    sendDailyDigest: async (db: Queryable, opts: { now: Date }) => {
      const { rows } = await db.query<{ id: number }>("SELECT current_hostel_id() AS id");
      if (rows[0].id === failing.hostel) throw new Error("planted digest failure");
      return actual.sendDailyDigest(db, opts);
    },
  };
});

const db = testPool();
afterAll(() => db.end());

const SECRET = "test-secret-that-is-at-least-32-characters";
const JOB_SECRET = "job-secret-for-tests-" + "j".repeat(20);
const NOW = new Date();
const DAY = 86_400_000;

// A new hostel with an owner and one notification 90 days old, which the prune job
// deletes when that hostel's jobs run to the end.
async function hostelWithOldNotification(c: PoolClient, name: string) {
  const hostel = (await c.query<{ id: number }>("INSERT INTO hostels (name) VALUES ($1) RETURNING id", [name])).rows[0]
    .id;
  await asHostel(c, hostel);
  const owner = await insertOwner(c);
  const notification = (
    await c.query<{ id: number }>(
      "INSERT INTO notifications (user_id, type, title, created_at) VALUES ($1, 'announcement', 'Old', $2) RETURNING id",
      [owner, new Date(NOW.getTime() - 90 * DAY)],
    )
  ).rows[0].id;
  return { hostel, notification };
}

const exists = async (c: PoolClient, { hostel, notification }: { hostel: number; notification: number }) => {
  await asHostel(c, hostel);
  return (await c.query("SELECT 1 FROM notifications WHERE id = $1", [notification])).rowCount === 1;
};

describe("run-jobs with more than one hostel", () => {
  it("rolls back a failing hostel's jobs, still runs the hostels after it, and answers 500", () =>
    inRollback(db, async (c) => {
      const broken = await hostelWithOldNotification(c, "Broken Hostel");
      const healthy = await hostelWithOldNotification(c, "Healthy Hostel");
      failing.hostel = broken.hostel;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET, jobSecret: JOB_SECRET, storage: null, clock: () => NOW });
        const res = await request(app).post("/api/internal/run-jobs").set("X-Job-Secret", JOB_SECRET);

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("jobs_failed");
        // The broken hostel's prune was undone with the rest of its jobs; the healthy one,
        // which runs after it, pruned its own.
        expect(await exists(c, broken)).toBe(true);
        expect(await exists(c, healthy)).toBe(false);
        expect(errors).toHaveBeenCalledWith(`run-jobs: the jobs of hostel ${broken.hostel} failed`, expect.any(Error));
        expect(errors).toHaveBeenCalledTimes(1);
      } finally {
        errors.mockRestore();
        failing.hostel = 0;
      }
    }));
});

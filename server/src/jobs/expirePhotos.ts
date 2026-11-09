import { withHostel, type Db } from "../db";
import type { PhotoStorage } from "../lib/storage";

// The expire-photos job (design doc, sections 9 and 10), run by POST /api/internal/run-jobs
// every hour. Complaint photos live 48 hours; this deletes the ones whose time is up.
// Written by Claude at Nikhil's request (section 12 lists "expiry and retry logic" under
// "You write"). tests/expirePhotos.test.ts describes it.

// Photos per run (section 10: "up to 50").
export const EXPIRE_BATCH = 50;
// A run starts no new photo after this long, so the hourly call stays short even when
// storage is slow (each storage request gives up after 15 seconds).
export const EXPIRE_TIME_LIMIT_MS = 60_000;

export type ExpireResult = { deleted: number; failed: number };

// Deletes one hostel's due photos from storage (run-jobs calls it for each hostel in
// turn), oldest expiry first: at most `limit` per run, and none started after `timeLimitMs`. A photo is due when it exists, is not deleted yet, and its
// photo_expires_at is `now` or earlier.
//
// For each due photo, in its own transaction, marked with the hostel (withHostel):
//   - storage deletes it, or says it no longer had it (decided on day 8: the goal is
//     met): photo_deleted_at = `now`. Only then is the deletion recorded (section 10).
//   - storage refuses, does not answer, or anything else goes wrong asking it:
//     photo_delete_attempts goes up by one, and the next hourly run tries again. There is
//     no last attempt (decided on day 8): after DELETE_WARNING_ATTEMPTS failures the
//     dashboard warns, and the job keeps trying.
// A photo is tried at most once per run. Nothing else about the complaint changes: no
// status, no updated_at, no timeline event, no notification. It changes no student, so
// the student-row lock rule does not apply.
//
// Two runs at the same moment (a late scheduled run meeting the next one) never handle
// the same photo: each claims its photo with FOR UPDATE SKIP LOCKED and holds the lock
// until that photo is recorded, so the other run takes a different one. While a photo is
// being deleted, a status change on that complaint waits for it (at most ~15 seconds).
//
// Without storage (photo uploads off) there is nothing to delete.
export async function expirePhotos(
  db: Db,
  storage: PhotoStorage | null,
  opts: { hostelId: number; now: Date; limit?: number; timeLimitMs?: number },
): Promise<ExpireResult> {
  const result: ExpireResult = { deleted: 0, failed: 0 };
  if (!storage) return result;

  const limit = opts.limit ?? EXPIRE_BATCH;
  const timeLimitMs = opts.timeLimitMs ?? EXPIRE_TIME_LIMIT_MS;
  const started = Date.now();
  const tried: number[] = [];

  while (tried.length < limit && Date.now() - started < timeLimitMs) {
    // withHostel commits, or rolls back and passes the error on.
    const nothingLeft = await withHostel(db, opts.hostelId, async (tx) => {
      const { rows } = await tx.query<{ id: number; path: string }>(
        `SELECT id, photo_path AS path
         FROM complaints
         WHERE hostel_id = current_hostel_id()
           AND photo_path IS NOT NULL AND photo_deleted_at IS NULL AND photo_expires_at <= $1
           AND id <> ALL($2::bigint[])
         ORDER BY photo_expires_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [opts.now, tried],
      );
      if (rows.length === 0) return true;
      const { id, path } = rows[0];
      tried.push(id);

      let confirmed = false;
      try {
        await storage.remove(path); // true: deleted now; false: it was already gone
        confirmed = true;
      } catch {
        // Counted below; the error itself is not logged (it names nothing useful and
        // the attempt counter is what the dashboard shows).
      }

      if (confirmed) {
        await tx.query("UPDATE complaints SET photo_deleted_at = $2 WHERE id = $1 AND hostel_id = current_hostel_id()", [id, opts.now]);
        result.deleted += 1;
      } else {
        await tx.query("UPDATE complaints SET photo_delete_attempts = photo_delete_attempts + 1 WHERE id = $1 AND hostel_id = current_hostel_id()", [
          id,
        ]);
        result.failed += 1;
      }
      return false;
    });
    if (nothingLeft) break;
  }
  return result;
}

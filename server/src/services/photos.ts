import type { Queryable } from "../db";
import { StorageError, type PhotoStorage } from "../lib/storage";
import { egressKey } from "./usage";

// Complaint photos as the detail pages show them (design doc, sections 5, 9 and 10).
// tests/photoLink.test.ts describes issuePhotoLink.

// A complaint's photo columns (complaints.photo_*).
export type PhotoFields = {
  path: string | null;
  sizeBytes: number | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
};

// A short-lived link to the photo for one view of a complaint's detail page, or null.
// Written by Claude at Nikhil's request (section 12 lists it under "You write").
//
// null, with nothing asked of storage and nothing counted, when:
//   - the complaint has no photo, or it is deleted (deletedAt set);
//   - `now` is at or after expiresAt, even while the job has not deleted it yet
//     (section 5: no link is issued after the expiry time);
//   - there is no storage (photo uploads are off).
// Otherwise it asks storage for a link that works for `seconds` (PHOTO_LINK_SECONDS) and,
// only once the link is issued, adds the photo's size to the egress counter of the month
// `now` falls in, in India's calendar (egressKey). Every view counts, since every link
// can be downloaded. A link storage refused or did not answer for was never served: null,
// and nothing is counted (the page then shows the complaint without its photo).
//
// The counter grows in one statement (INSERT ... ON CONFLICT DO UPDATE value = value + n),
// so views at the same moment are all counted. The link is never logged.
export async function issuePhotoLink(
  db: Queryable,
  storage: PhotoStorage | null,
  photo: PhotoFields,
  opts: { now: Date; seconds: number },
): Promise<string | null> {
  const { path, sizeBytes, expiresAt, deletedAt } = photo;
  if (!storage || !path || !sizeBytes || !expiresAt || deletedAt) return null;
  if (opts.now.getTime() >= expiresAt.getTime()) return null;

  let link: string;
  try {
    link = await storage.signedUrl(path, opts.seconds);
  } catch (err) {
    if (err instanceof StorageError) return null;
    throw err;
  }

  await db.query(
    `INSERT INTO usage_counters (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = usage_counters.value + EXCLUDED.value, updated_at = now()`,
    [egressKey(opts.now), sizeBytes],
  );
  return link;
}

// ---- The photo on a detail page (day 8) ----
// tests/photoView.test.ts describes the three functions below.

// A complaint's photo columns. The caller has already checked the reader may see the
// complaint (the student's ownership filter, or the owner).
export async function getComplaintPhoto(db: Queryable, complaintId: number): Promise<PhotoFields> {
  const { rows } = await db.query<PhotoFields>(
    `SELECT photo_path AS path, photo_size_bytes AS "sizeBytes",
            photo_expires_at AS "expiresAt", photo_deleted_at AS "deletedAt"
     FROM complaints WHERE id = $1 AND hostel_id = current_hostel_id()`,
    [complaintId],
  );
  return rows[0] ?? { path: null, sizeBytes: null, expiresAt: null, deletedAt: null };
}

// What the owner's detail page shows (section 9: the photo with its countdown):
//   null           the complaint never had a photo
//   available      a link (issuePhotoLink: short-lived, counted as egress)
//   unavailable    live, but no link could be had: uploads are off or storage did not
//                  answer; the page says to try again later
//   expired        from expiresAt on, or once deleted (the job may not have run yet)
// expiresAt is always given, so the page can count down or say when it expired.
export type PhotoView =
  | { status: "available"; url: string; expiresAt: Date }
  | { status: "unavailable"; expiresAt: Date }
  | { status: "expired"; expiresAt: Date };

export async function photoView(
  db: Queryable,
  storage: PhotoStorage | null,
  photo: PhotoFields,
  opts: { now: Date; seconds: number },
): Promise<PhotoView | null> {
  if (!photo.path || !photo.expiresAt) return null;
  const expiresAt = photo.expiresAt;
  if (photo.deletedAt || opts.now.getTime() >= expiresAt.getTime()) return { status: "expired", expiresAt };
  const url = await issuePhotoLink(db, storage, photo, opts);
  return url ? { status: "available", url, expiresAt } : { status: "unavailable", expiresAt };
}

// The student's version: the same, without the expiry time (decided on day 8: the student
// sees their own photo until it expires, with no countdown).
export type StudentPhotoView = { status: "available"; url: string } | { status: "unavailable" | "expired" };

export function studentPhotoView(view: PhotoView | null): StudentPhotoView | null {
  if (!view) return null;
  return view.status === "available" ? { status: "available", url: view.url } : { status: view.status };
}

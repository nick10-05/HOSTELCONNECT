import { afterAll, describe, expect, it } from "vitest";
import { getComplaintPhoto, photoView, studentPhotoView, type PhotoFields } from "../src/services/photos";
import { inRollback, insertStudent, testPool } from "./helpers/db";
import { fakeStorage } from "./helpers/fakeStorage";

// What a complaint's detail page shows of its photo (day 8): nothing, a short-lived link,
// "unavailable" (storage off or not answering) or "expired". The owner also gets the
// expiry time for the countdown; the student does not (decided on day 8). The link and
// its egress counting are issuePhotoLink's (tests/photoLink.test.ts); egress months here
// are in 2003.
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("2003-04-10T06:00:00Z");
const EXPIRES = new Date("2003-04-11T06:00:00Z");
const PATH = "complaints/0b7c4c55-3f43-4c3b-9f0e-6f6f5a1d2e10.jpg";
const live: PhotoFields = { path: PATH, sizeBytes: 1000, expiresAt: EXPIRES, deletedAt: null };
const opts = { now: NOW, seconds: 60 };

describe("photoView", () => {
  it("is null for a complaint without a photo, asking storage nothing", () =>
    inRollback(db, async (c) => {
      const storage = fakeStorage();
      const none: PhotoFields = { path: null, sizeBytes: null, expiresAt: null, deletedAt: null };
      expect(await photoView(c, storage, none, opts)).toBeNull();
      expect(storage.calls).toEqual([]);
    }));

  it("gives a link and the expiry time while the photo is live", () =>
    inRollback(db, async (c) => {
      const storage = fakeStorage();
      storage.objects.set(PATH, { bytes: new Uint8Array(1000), type: "image/jpeg" });
      expect(await photoView(c, storage, live, opts)).toEqual({
        status: "available",
        url: `https://fake-storage.test/object/sign/${PATH}?expires_in=60`,
        expiresAt: EXPIRES,
      });
    }));

  it("is expired from the expiry time on, or once deleted, without asking storage", () =>
    inRollback(db, async (c) => {
      const storage = fakeStorage();
      expect(await photoView(c, storage, live, { ...opts, now: EXPIRES })).toEqual({
        status: "expired",
        expiresAt: EXPIRES,
      });
      expect(await photoView(c, storage, { ...live, deletedAt: NOW }, opts)).toEqual({
        status: "expired",
        expiresAt: EXPIRES,
      });
      expect(storage.calls).toEqual([]);
    }));

  it("is unavailable while the photo is live but no link can be had", () =>
    inRollback(db, async (c) => {
      const storage = fakeStorage();
      storage.objects.set(PATH, { bytes: new Uint8Array(1000), type: "image/jpeg" });
      storage.failNext("sign", 500);
      expect(await photoView(c, storage, live, opts)).toEqual({ status: "unavailable", expiresAt: EXPIRES });
      // Uploads switched off: the photo still exists, but there is no storage to ask.
      expect(await photoView(c, null, live, opts)).toEqual({ status: "unavailable", expiresAt: EXPIRES });
    }));
});

describe("studentPhotoView", () => {
  it("is the same answer without the expiry time", () => {
    expect(studentPhotoView(null)).toBeNull();
    expect(studentPhotoView({ status: "available", url: "https://x.test/a", expiresAt: EXPIRES })).toEqual({
      status: "available",
      url: "https://x.test/a",
    });
    expect(studentPhotoView({ status: "expired", expiresAt: EXPIRES })).toEqual({ status: "expired" });
    expect(studentPhotoView({ status: "unavailable", expiresAt: EXPIRES })).toEqual({ status: "unavailable" });
  });
});

describe("getComplaintPhoto", () => {
  it("reads a complaint's photo columns", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes, photo_expires_at, photo_deleted_at)
         VALUES ($1, 'furniture', 'The cupboard door is broken.', $2, 1000, $3, $4),
                ($1, 'food', 'The rice was undercooked today.', NULL, NULL, NULL, NULL)
         RETURNING id`,
        [student, PATH, EXPIRES, NOW],
      );
      expect(await getComplaintPhoto(c, rows[0].id)).toEqual({ ...live, deletedAt: NOW });
      expect(await getComplaintPhoto(c, rows[1].id)).toEqual({
        path: null,
        sizeBytes: null,
        expiresAt: null,
        deletedAt: null,
      });
    }));
});

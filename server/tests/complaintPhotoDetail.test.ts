import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { newPhotoPath } from "../src/lib/storage";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { fakeStorage, type FakeStorage } from "./helpers/fakeStorage";

// The photo on GET /api/complaints/:id (design doc, section 5: "photo link only before its
// expiry time"), day 8. The owner gets the expiry time for the countdown, the student
// does not. The owner's writes answer with the same view. Committed test database, fake
// storage, the app's clock fixed in July 2004 (an egress month no other test touches).
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("2004-07-01T06:00:00Z");
const HOUR = 3_600_000;
const newApp = (storage: FakeStorage | null, extra: Partial<AppDeps> = {}) =>
  createApp({ db, jwtSecret: SECRET, storage, clock: () => NOW, photoLinkSeconds: 45, ...extra });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

// A complaint with a photo that expires `hoursLeft` after NOW (negative: already past),
// written straight to the table, and the object put in `storage`.
async function withPhoto(storage: FakeStorage | null, hoursLeft: number, opts: { deleted?: boolean } = {}) {
  const student = await insertStudent(db);
  const path = newPhotoPath("image/jpeg");
  storage?.objects.set(path, { bytes: new Uint8Array(2000), type: "image/jpeg" });
  const expiresAt = new Date(NOW.getTime() + hoursLeft * HOUR);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, photo_path, photo_size_bytes,
                             photo_expires_at, photo_deleted_at, created_at)
     VALUES ($1, 'furniture', 'The cupboard door in room 204 fell off.', $2, 2000, $3::timestamptz, $4,
             $3::timestamptz - interval '48 hours')
     RETURNING id`,
    [student, path, expiresAt, opts.deleted ? NOW : null],
  );
  return { id: rows[0].id, student, path, expiresAt: expiresAt.toISOString() };
}

const egressThisMonth = async () =>
  (await db.query<{ value: number }>("SELECT value FROM usage_counters WHERE key = 'egress:2004-07'")).rows[0]?.value ?? 0;

describe("GET /api/complaints/:id with a photo", () => {
  it("gives the owner a short-lived link and the expiry time, and counts the view", async () => {
    const storage = fakeStorage();
    const c = await withPhoto(storage, 30);
    const before = await egressThisMonth();
    const owner = cookieFor(await insertOwner(db), "owner");

    const res = await request(newApp(storage)).get(`/api/complaints/${c.id}`).set("Cookie", owner);
    expect(res.status).toBe(200);
    expect(res.body.photo).toEqual({
      status: "available",
      url: `https://fake-storage.test/object/sign/${c.path}?expires_in=45`,
      expiresAt: c.expiresAt,
    });
    expect(await egressThisMonth()).toBe(before + 2000);
  });

  it("gives the student their own photo's link without the expiry time, and is never cached", async () => {
    const storage = fakeStorage();
    const c = await withPhoto(storage, 30);
    const res = await request(newApp(storage)).get(`/api/complaints/${c.id}`).set("Cookie", cookieFor(c.student, "student"));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.photo).toEqual({ status: "available", url: `https://fake-storage.test/object/sign/${c.path}?expires_in=45` });
  });

  it("issues no link for another student's complaint: a plain 404", async () => {
    const storage = fakeStorage();
    const c = await withPhoto(storage, 30);
    const other = cookieFor(await insertStudent(db), "student");
    const res = await request(newApp(storage)).get(`/api/complaints/${c.id}`).set("Cookie", other);
    expect(res.status).toBe(404);
    expect(storage.calls).toEqual([]);
  });

  it("says expired, with no link, once the time is up or the photo is deleted", async () => {
    const storage = fakeStorage();
    const past = await withPhoto(storage, -1);
    const deleted = await withPhoto(storage, 10, { deleted: true });
    const owner = cookieFor(await insertOwner(db), "owner");
    const app = newApp(storage);

    for (const c of [past, deleted]) {
      const asOwner = await request(app).get(`/api/complaints/${c.id}`).set("Cookie", owner);
      expect(asOwner.body.photo).toEqual({ status: "expired", expiresAt: c.expiresAt });
      const asStudent = await request(app).get(`/api/complaints/${c.id}`).set("Cookie", cookieFor(c.student, "student"));
      expect(asStudent.body.photo).toEqual({ status: "expired" });
    }
    expect(storage.calls).toEqual([]);
  });

  it("says unavailable while the photo is live but uploads are off", async () => {
    const c = await withPhoto(null, 30);
    const owner = cookieFor(await insertOwner(db), "owner");
    const res = await request(newApp(null)).get(`/api/complaints/${c.id}`).set("Cookie", owner);
    expect(res.body.photo).toEqual({ status: "unavailable", expiresAt: c.expiresAt });
  });

  it("has photo null for a complaint without one, for both", async () => {
    const student = await insertStudent(db);
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO complaints (student_id, category, description) VALUES ($1, 'food', 'The rice was cold today.') RETURNING id`,
      [student],
    );
    const app = newApp(fakeStorage());
    const owner = await request(app).get(`/api/complaints/${rows[0].id}`).set("Cookie", cookieFor(await insertOwner(db), "owner"));
    const own = await request(app).get(`/api/complaints/${rows[0].id}`).set("Cookie", cookieFor(student, "student"));
    expect(owner.body.photo).toBeNull();
    expect(own.body.photo).toBeNull();
  });

  it("answers the owner's status change, priority and note with the photo too", async () => {
    const storage = fakeStorage();
    const c = await withPhoto(storage, 30);
    const owner = cookieFor(await insertOwner(db), "owner");
    const app = newApp(storage);
    const expected = { status: "available", url: expect.stringContaining(c.path), expiresAt: c.expiresAt };

    const moved = await request(app).post(`/api/complaints/${c.id}/status`).set("Cookie", owner).send({ from: "open", to: "in_progress" });
    expect(moved.status).toBe(200);
    expect(moved.body.photo).toEqual(expected);
    const priority = await request(app).patch(`/api/complaints/${c.id}`).set("Cookie", owner).send({ priority: "high" });
    expect(priority.body.photo).toEqual(expected);
    const note = await request(app).post(`/api/complaints/${c.id}/notes`).set("Cookie", owner).send({ note: "Carpenter on Monday." });
    expect(note.body.photo).toEqual(expected);
  });
});

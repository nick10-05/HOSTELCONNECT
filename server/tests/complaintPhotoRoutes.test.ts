import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertStudent, testPool } from "./helpers/db";
import { fakeStorage } from "./helpers/fakeStorage";

// POST /api/complaints with the optional photo (day 8): multipart form data with the
// fields category and description and at most one file named "photo". JSON without a
// photo still works. Committed test database, fake storage; the clock is in March 2002,
// an egress month no other test touches.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("2002-03-15T06:30:00Z");
const MB = 1024 * 1024;
const TEXT = "The window latch in room 204 is broken.";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

const newApp = (extra: Partial<AppDeps> = {}) =>
  createApp({ db, jwtSecret: SECRET, storage: fakeStorage(), clock: () => NOW, ...extra });
const cookieFor = (userId: number) => `${SESSION_COOKIE}=${signSession({ userId, role: "student" }, SECRET)}`;

const photosOf = async (student: number) =>
  (
    await db.query("SELECT photo_path AS path, photo_size_bytes AS size FROM complaints WHERE student_id = $1", [
      student,
    ])
  ).rows;

// A multipart complaint from a new student; `attach` adds files.
async function send(app: ReturnType<typeof newApp>, attach: (r: request.Test) => request.Test = (r) => r) {
  const student = await insertStudent(db);
  const res = await attach(
    request(app).post("/api/complaints").set("Cookie", cookieFor(student)).field("category", "furniture").field("description", TEXT),
  );
  return { student, res };
}
const jpeg = (r: request.Test) => r.attach("photo", JPEG, { filename: "latch.jpg", contentType: "image/jpeg" });

describe("POST /api/complaints with a photo", () => {
  it("creates the complaint and stores the photo", async () => {
    const storage = fakeStorage();
    const { student, res } = await send(newApp({ storage }), jpeg);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category: "furniture", description: TEXT, status: "open" });
    // The student's answer has no photo fields.
    expect(Object.keys(res.body)).not.toContain("photoPath");
    const [row] = await photosOf(student);
    expect(row.size).toBe(JPEG.length);
    expect(storage.objects.get(row.path)?.type).toBe("image/jpeg");
  });

  it("decides the type from the bytes, not from the name or the claimed type", async () => {
    const storage = fakeStorage();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const { student, res } = await send(newApp({ storage }), (r) =>
      r.attach("photo", png, { filename: "photo.jpg", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(201);
    const [row] = await photosOf(student);
    expect(row.path).toMatch(/\.png$/);
    expect(storage.objects.get(row.path)?.type).toBe("image/png");
  });

  it("still takes a complaint without a photo, as form data or as JSON", async () => {
    const app = newApp();
    const { student, res } = await send(app);
    expect(res.status).toBe(201);
    expect(await photosOf(student)).toEqual([{ path: null, size: null }]);

    const other = await insertStudent(db);
    const json = await request(app).post("/api/complaints").set("Cookie", cookieFor(other)).send({ category: "food", description: TEXT });
    expect(json.status).toBe(201);
  });

  it("refuses a photo that is too large, before storing anything", async () => {
    const storage = fakeStorage();
    const big = Buffer.concat([JPEG, Buffer.alloc(2048)]);
    const { student, res } = await send(newApp({ storage, photoMaxBytes: 2048 }), (r) =>
      r.attach("photo", big, { filename: "big.jpg", contentType: "image/jpeg" }),
    );
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: "photo_too_large", message: "The photo can be at most 2 KB." } });
    expect(storage.calls).toEqual([]);
    expect(await photosOf(student)).toEqual([]);
  });

  it("states the default limit as 1 MB", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(MB)]);
    const { res } = await send(newApp(), (r) => r.attach("photo", big, { filename: "big.jpg", contentType: "image/jpeg" }));
    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe("The photo can be at most 1 MB.");
  });

  it("refuses anything that is not a JPEG, PNG or WebP image, whatever it claims to be", async () => {
    const storage = fakeStorage();
    for (const content of [GIF, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.alloc(0)]) {
      const { student, res } = await send(newApp({ storage }), (r) =>
        r.attach("photo", content, { filename: "photo.jpg", contentType: "image/jpeg" }),
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "photo_type", message: "The photo must be a JPEG, PNG or WebP image." } });
      expect(await photosOf(student)).toEqual([]);
    }
    expect(storage.calls).toEqual([]);
  });

  it("refuses a second file or a file under another name", async () => {
    const storage = fakeStorage();
    for (const attach of [
      (r: request.Test) => jpeg(jpeg(r)),
      (r: request.Test) => r.attach("image", JPEG, { filename: "latch.jpg", contentType: "image/jpeg" }),
    ]) {
      const { student, res } = await send(newApp({ storage }), attach);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_input");
      expect(await photosOf(student)).toEqual([]);
    }
    expect(storage.calls).toEqual([]);
  });

  it("checks the text before storing the photo", async () => {
    const storage = fakeStorage();
    const student = await insertStudent(db);
    const res = await jpeg(
      request(newApp({ storage })).post("/api/complaints").set("Cookie", cookieFor(student)).field("category", "sofa").field("description", TEXT),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(storage.calls).toEqual([]);
  });

  it("refuses a photo while uploads are off, with nothing created", async () => {
    // No storage configured.
    const off = await send(newApp({ storage: null }), jpeg);
    expect(off.res.status).toBe(409);
    expect(off.res.body).toEqual({
      error: {
        code: "photo_uploads_off",
        message: "Photo uploads are switched off for now. Please send the complaint without a photo.",
      },
    });
    expect(await photosOf(off.student)).toEqual([]);

    // The usage guard: 85% of a 1 MB egress limit this month.
    await db.query("INSERT INTO usage_counters (key, value) VALUES ('egress:2002-03', $1)", [Math.ceil(0.85 * MB)]);
    const storage = fakeStorage();
    const guarded = await send(newApp({ storage, usageLimits: { storageLimitMb: 450, egressLimitMb: 1 } }), jpeg);
    expect(guarded.res.status).toBe(409);
    expect(guarded.res.body.error.code).toBe("photo_uploads_off");
    expect(storage.calls).toEqual([]);
  });

  it("answers 503 when storage fails, so the student can send it without the photo", async () => {
    const storage = fakeStorage();
    storage.failNext("upload", 502);
    const { student, res } = await send(newApp({ storage }), jpeg);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("photo_upload_failed");
    expect(await photosOf(student)).toEqual([]);
  });
});

describe("GET /api/complaints tells the student whether a photo can be added", () => {
  const allowed = async (extra: Partial<AppDeps>) => {
    const student = await insertStudent(db);
    const res = await request(newApp(extra)).get("/api/complaints").set("Cookie", cookieFor(student));
    expect(res.status).toBe(200);
    return res.body.photoUploadsAllowed;
  };

  it("is true with storage and room under the guard, false otherwise", async () => {
    expect(await allowed({})).toBe(true);
    expect(await allowed({ storage: null })).toBe(false);
    // March 2002 is at 85% of a 1 MB limit after the test above; set it here too in case
    // this test runs alone.
    await db.query(
      `INSERT INTO usage_counters (key, value) VALUES ('egress:2002-03', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [Math.ceil(0.85 * MB)],
    );
    expect(await allowed({ usageLimits: { storageLimitMb: 450, egressLimitMb: 1 } })).toBe(false);
  });
});

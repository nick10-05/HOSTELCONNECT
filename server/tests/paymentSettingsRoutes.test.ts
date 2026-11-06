import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The payment-settings routes (day 9) through the real app: reading the owner's details,
// saving them with or without a QR image (multipart form data, or JSON without an image),
// and fetching the image. The service's rules are in paymentSettings.test.ts; these check
// who may call what, the form's fields, the image's size and type, and the answers. Each
// test runs the app on rollbackDb, so everything is rolled back.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const KB_200 = 200 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

type Ctx = { c: PoolClient; app: ReturnType<typeof createApp>; owner: string; student: string; studentId: number };

function withApp(fn: (ctx: Ctx) => Promise<void>) {
  return inRollback(db, async (c) => {
    const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET });
    const studentId = await insertStudent(c);
    await fn({
      c,
      app,
      owner: cookieFor(await insertOwner(c), "owner"),
      student: cookieFor(studentId, "student"),
      studentId,
    });
  });
}

const put = (app: Ctx["app"], cookie: string) => request(app).put("/api/settings/payment").set("Cookie", cookie);

const savedRow = async (c: PoolClient) =>
  (
    await c.query(
      `SELECT upi_id AS "upiId", upi_payee_name AS "upiPayeeName", qr_image AS "qrImage", qr_mime AS "qrMime"
       FROM hostel_settings`,
    )
  ).rows;

const expect400 = (res: request.Response, label: string) => {
  expect(res.status, label).toBe(400);
  expect(res.body.error.code, label).toBe("invalid_input");
};

describe("who may use the payment settings", () => {
  it("need a session for all three", () =>
    withApp(async ({ app }) => {
      expect((await request(app).get("/api/settings/payment")).status).toBe(401);
      expect((await request(app).get("/api/settings/payment/qr")).status).toBe(401);
      expect((await request(app).put("/api/settings/payment").send({ upiId: "owner@okaxis" })).status).toBe(401);
    }));

  it("let a student read the details and the QR, never change them", () =>
    withApp(async ({ c, app, owner, student }) => {
      await put(app, owner).field("upiId", "owner@okaxis").attach("qr", PNG, { filename: "qr.png" });
      expect((await request(app).get("/api/settings/payment").set("Cookie", student)).status).toBe(200);
      expect((await request(app).get("/api/settings/payment/qr").set("Cookie", student)).status).toBe(200);
      const res = await put(app, student).send({ upiId: "thief@ybl" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(await savedRow(c)).toMatchObject([{ upiId: "owner@okaxis" }]);
    }));

  it("refuse an owner who still has a temporary password, and a save sent from another site", () =>
    withApp(async ({ c, app, owner }) => {
      const temporary = cookieFor(await insertOwner(c, { mustChangePassword: true }), "owner");
      const res = await put(app, temporary).send({ upiId: "owner@okaxis" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");
      const cross = await put(app, owner).set("Origin", "https://elsewhere.example").send({ upiId: "owner@okaxis" });
      expect(cross.status).toBe(403);
      expect(cross.body.error.code).toBe("cross_origin");
      expect(await savedRow(c)).toEqual([]);
    }));
});

describe("GET /api/settings/payment", () => {
  it("answers nulls before the first save, and is never cached", () =>
    withApp(async ({ app, student }) => {
      const res = await request(app).get("/api/settings/payment").set("Cookie", student);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({ upiId: null, upiPayeeName: null, qrUrl: null, updatedAt: null });
    }));
});

describe("PUT /api/settings/payment", () => {
  it("saves the UPI ID and payee name from JSON, trimmed, tells the students and answers the details", () =>
    withApp(async ({ c, app, owner, studentId }) => {
      const res = await put(app, owner).send({ upiId: "  owner@okaxis ", upiPayeeName: " Sri Lakshmi Hostel\n" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel", qrUrl: null });
      expect(typeof res.body.updatedAt).toBe("string");
      const { rows } = await c.query(`SELECT type FROM notifications WHERE user_id = $1`, [studentId]);
      expect(rows).toEqual([{ type: "payment_update" }]);
    }));

  it("saves a QR image from form data, typed by its bytes, and the image comes back from its address", () =>
    withApp(async ({ c, app, owner, student }) => {
      // Named .jpg and claimed as JPEG, but the bytes are a PNG.
      const res = await put(app, owner)
        .field("upiPayeeName", "Sri Lakshmi Hostel")
        .attach("qr", PNG, { filename: "qr.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body.upiId).toBeNull();
      expect(res.body.qrUrl).toMatch(/^\/api\/settings\/payment\/qr\?v=\d+$/);
      expect(await savedRow(c)).toMatchObject([{ qrImage: PNG, qrMime: "image/png" }]);

      const qr = await request(app).get(res.body.qrUrl).set("Cookie", student);
      expect(qr.status).toBe(200);
      expect(qr.headers["content-type"]).toBe("image/png");
      expect(qr.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(qr.headers["x-content-type-options"]).toBe("nosniff");
      expect(Buffer.compare(qr.body, PNG)).toBe(0);
    }));

  it("keeps the saved QR when no image is sent, and removes it with removeQr", () =>
    withApp(async ({ c, app, owner }) => {
      await put(app, owner).field("upiId", "owner@okaxis").attach("qr", JPEG, { filename: "qr.jpg" });
      const kept = await put(app, owner).field("upiId", "owner@ybl");
      expect(kept.status).toBe(200);
      expect(kept.body.qrUrl).not.toBeNull();
      expect(await savedRow(c)).toMatchObject([{ upiId: "owner@ybl", qrImage: JPEG, qrMime: "image/jpeg" }]);

      const removed = await put(app, owner).field("upiId", "owner@ybl").field("removeQr", "true");
      expect(removed.status).toBe(200);
      expect(removed.body.qrUrl).toBeNull();
      expect(await savedRow(c)).toMatchObject([{ qrImage: null, qrMime: null }]);
      expect((await put(app, owner).send({ upiId: "owner@ybl", removeQr: false })).status).toBe(200);
    }));

  it("clears a blank or missing UPI ID and payee name", () =>
    withApp(async ({ c, app, owner }) => {
      await put(app, owner).send({ upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel" });
      await put(app, owner).field("upiId", "   ").attach("qr", PNG, { filename: "qr.png" });
      expect(await savedRow(c)).toMatchObject([{ upiId: null, upiPayeeName: null }]);
    }));

  it("refuses to leave neither a UPI ID nor a QR image", () =>
    withApp(async ({ c, app, owner }) => {
      const res = await put(app, owner).send({ upiPayeeName: "Sri Lakshmi Hostel" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "payment_details_missing", message: "Add a UPI ID or a QR image." } });
      expect(await savedRow(c)).toEqual([]);
    }));

  it("checks the UPI ID, the payee name and removeQr", () =>
    withApp(async ({ c, app, owner }) => {
      for (const body of [
        { upiId: "owner" },
        { upiId: "@okaxis" },
        { upiId: "owner@" },
        { upiId: "owner@ok@axis" },
        { upiId: "own er@okaxis" },
        { upiId: "own\u0000er@okaxis" },
        { upiId: `${"a".repeat(249)}@okaxis` }, // 256 characters
        { upiId: 42 },
        { upiId: "owner@okaxis", upiPayeeName: "x".repeat(101) },
        { upiId: "owner@okaxis", upiPayeeName: "Sri\u0000Lakshmi" },
        { upiId: "owner@okaxis", removeQr: "yes" },
        { upiId: "owner@okaxis", colour: "blue" },
      ]) {
        expect400(await put(app, owner).send(body), JSON.stringify(body));
      }
      expect(await savedRow(c)).toEqual([]);
      // Longest allowed: 255 characters in the UPI ID, 100 in the name (an emoji is one).
      const longest = await put(app, owner).send({ upiId: `${"a".repeat(247)}@okaxis`, upiPayeeName: "🏠".repeat(100) });
      expect(longest.status).toBe(200);
    }));

  it("refuses a QR image together with removeQr", () =>
    withApp(async ({ c, app, owner }) => {
      const res = await put(app, owner)
        .field("upiId", "owner@okaxis")
        .field("removeQr", "true")
        .attach("qr", PNG, { filename: "qr.png" });
      expect400(res, "image and removeQr");
      expect(await savedRow(c)).toEqual([]);
    }));

  it("takes a QR image of 200 KB, and refuses a larger one", () =>
    withApp(async ({ c, app, owner }) => {
      const at = Buffer.concat([PNG, Buffer.alloc(KB_200 - PNG.length)]);
      expect((await put(app, owner).attach("qr", at, { filename: "qr.png" })).status).toBe(200);
      const over = await put(app, owner).field("upiId", "owner@okaxis").attach("qr", Buffer.concat([at, Buffer.from([0])]), {
        filename: "qr.png",
      });
      expect(over.status).toBe(413);
      expect(over.body).toEqual({ error: { code: "qr_too_large", message: "The QR image can be at most 200 KB." } });
      expect(await savedRow(c)).toMatchObject([{ upiId: null }]);
    }));

  it("refuses an image that is not a JPEG, PNG or WebP, whatever its name", () =>
    withApp(async ({ c, app, owner }) => {
      for (const [label, bytes] of [
        ["GIF", GIF],
        ["SVG", SVG],
        ["empty", Buffer.alloc(0)],
      ] as const) {
        const res = await put(app, owner).field("upiId", "owner@okaxis").attach("qr", bytes, { filename: "qr.png", contentType: "image/png" });
        expect(res.status, label).toBe(400);
        expect(res.body, label).toEqual({ error: { code: "qr_type", message: "The QR image must be a JPEG, PNG or WebP image." } });
      }
      expect(await savedRow(c)).toEqual([]);
    }));

  it("refuses a file under another name, a second file and extra fields", () =>
    withApp(async ({ c, app, owner }) => {
      expect400(await put(app, owner).attach("photo", PNG, { filename: "qr.png" }), "other name");
      expect400(
        await put(app, owner).attach("qr", PNG, { filename: "a.png" }).attach("qr", JPEG, { filename: "b.jpg" }),
        "two files",
      );
      const extra = await put(app, owner)
        .field("upiId", "owner@okaxis")
        .field("upiPayeeName", "Sri Lakshmi Hostel")
        .field("removeQr", "false")
        .field("colour", "blue");
      expect400(extra, "a fourth field");
      expect(extra.body.error.message).toBe("qr: send at most one file, named qr, with upiId, upiPayeeName and removeQr");
      expect(await savedRow(c)).toEqual([]);
    }));
});

describe("GET /api/settings/payment/qr", () => {
  it("answers 404 when no QR image is saved", () =>
    withApp(async ({ app, owner, student }) => {
      await put(app, owner).send({ upiId: "owner@okaxis" });
      const res = await request(app).get("/api/settings/payment/qr").set("Cookie", student);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "qr_not_set", message: "No QR image has been uploaded." } });
    }));
});

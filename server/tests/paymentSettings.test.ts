import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  getPaymentQr,
  getPaymentSettings,
  PAYMENT_QR_PATH,
  PAYMENT_SETTINGS_LINK,
  savePaymentSettings,
  type PaymentChange,
} from "../src/services/paymentSettings";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";
import { rollbackDb } from "./helpers/rollbackDb";

// The owner's payment details (day 9): reading them, the QR image, and saving them with the
// notification to every active student. Each test runs in one rolled-back transaction, so
// no test sees another's row. now() is fixed inside a transaction, so a test that needs
// updated_at to move first sets it to an old time.
const db = testPool();
afterAll(() => db.end());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const OLD = "2000-01-01T00:00:00.000Z";

const UPI_ONLY: PaymentChange = { upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel", qr: null };

const save = (c: PoolClient, change: PaymentChange) => savePaymentSettings(rollbackDb(c), change);

const row = async (c: PoolClient) =>
  (
    await c.query(
      `SELECT upi_id AS "upiId", upi_payee_name AS "upiPayeeName", qr_image AS "qrImage", qr_mime AS "qrMime",
              updated_at AS "updatedAt"
       FROM hostel_settings`,
    )
  ).rows;

const ageRow = (c: PoolClient) => c.query(`UPDATE hostel_settings SET updated_at = $1`, [OLD]);

const noticesOf = async (c: PoolClient, userId: number) =>
  (await c.query(`SELECT type, title, body, link, dedup_key AS "dedupKey" FROM notifications WHERE user_id = $1`, [userId]))
    .rows;

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("getPaymentSettings and getPaymentQr", () => {
  it("give nothing before the first save", () =>
    inRollback(db, async (c) => {
      expect(await getPaymentSettings(c)).toEqual({ upiId: null, upiPayeeName: null, qrUrl: null, updatedAt: null });
      expect(await getPaymentQr(c)).toBeNull();
    }));

  it("give the saved details, the QR's address with the time of the last change, and the image", () =>
    inRollback(db, async (c) => {
      await c.query(
        `INSERT INTO hostel_settings (upi_id, upi_payee_name, qr_image, qr_mime, updated_at)
         VALUES ('owner@okaxis', 'Sri Lakshmi Hostel', $1, 'image/png', '2026-11-06T10:15:30.123Z')`,
        [PNG],
      );
      expect(await getPaymentSettings(c)).toEqual({
        upiId: "owner@okaxis",
        upiPayeeName: "Sri Lakshmi Hostel",
        qrUrl: `${PAYMENT_QR_PATH}?v=${Date.parse("2026-11-06T10:15:30.123Z")}`,
        updatedAt: "2026-11-06T10:15:30.123Z",
      });
      const qr = await getPaymentQr(c);
      expect(qr?.mime).toBe("image/png");
      expect(Buffer.compare(qr!.bytes, PNG)).toBe(0);
    }));

  it("give no QR address when only the UPI ID is set", () =>
    inRollback(db, async (c) => {
      await c.query(`INSERT INTO hostel_settings (upi_id) VALUES ('owner@okaxis')`);
      expect((await getPaymentSettings(c)).qrUrl).toBeNull();
      expect(await getPaymentQr(c)).toBeNull();
    }));
});

describe("savePaymentSettings", () => {
  it("creates the details on the first save and tells every active student", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const gone = await insertStudent(c, { isActive: false });
      const owner = await insertOwner(c);

      const saved = await save(c, UPI_ONLY);

      expect(saved).toMatchObject({ upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel", qrUrl: null });
      expect(saved).toEqual(await getPaymentSettings(c));
      expect(await row(c)).toHaveLength(1);
      expect(await noticesOf(c, student)).toEqual([
        {
          type: "payment_update",
          title: "The hostel's payment details have changed.",
          body: null,
          link: PAYMENT_SETTINGS_LINK,
          dedupKey: null,
        },
      ]);
      expect(await noticesOf(c, gone)).toEqual([]);
      expect(await noticesOf(c, owner)).toEqual([]);
    }));

  it("stores a QR image with its type, keeps it, replaces it and removes it", () =>
    inRollback(db, async (c) => {
      await save(c, { ...UPI_ONLY, qr: { bytes: PNG, mime: "image/png" } });
      expect((await getPaymentQr(c))?.mime).toBe("image/png");
      expect((await getPaymentSettings(c)).qrUrl).toMatch(/^\/api\/settings\/payment\/qr\?v=\d+$/);

      await save(c, { upiId: "owner@ybl", upiPayeeName: null, qr: "keep" });
      expect(await row(c)).toMatchObject([{ upiId: "owner@ybl", upiPayeeName: null, qrImage: PNG, qrMime: "image/png" }]);

      await save(c, { upiId: "owner@ybl", upiPayeeName: null, qr: { bytes: JPEG, mime: "image/jpeg" } });
      expect(await row(c)).toMatchObject([{ qrImage: JPEG, qrMime: "image/jpeg" }]);

      const removed = await save(c, { upiId: "owner@ybl", upiPayeeName: null, qr: null });
      expect(removed.qrUrl).toBeNull();
      expect(await row(c)).toMatchObject([{ qrImage: null, qrMime: null }]);
    }));

  it("takes a QR image without a UPI ID", () =>
    inRollback(db, async (c) => {
      const saved = await save(c, { upiId: null, upiPayeeName: null, qr: { bytes: PNG, mime: "image/png" } });
      expect(saved.upiId).toBeNull();
      expect(saved.qrUrl).not.toBeNull();
    }));

  it("refuses to leave neither a UPI ID nor a QR image, and changes nothing", () =>
    inRollback(db, async (c) => {
      const student = await insertStudent(c);
      const first = await refusal(save(c, { upiId: null, upiPayeeName: "Sri Lakshmi Hostel", qr: null }));
      expect(first).toMatchObject({ status: 400, code: "payment_details_missing", message: "Add a UPI ID or a QR image." });
      expect(await row(c)).toEqual([]);

      await save(c, { upiId: null, upiPayeeName: null, qr: { bytes: PNG, mime: "image/png" } });
      const before = await row(c);
      const notices = (await noticesOf(c, student)).length;
      const cleared = await refusal(save(c, { upiId: null, upiPayeeName: null, qr: null }));
      expect(cleared.code).toBe("payment_details_missing");
      expect(await row(c)).toEqual(before);
      // "keep" with no saved image is no image either.
      await c.query(`UPDATE hostel_settings SET upi_id = 'owner@okaxis', qr_image = NULL, qr_mime = NULL`);
      expect((await refusal(save(c, { upiId: null, upiPayeeName: null, qr: "keep" }))).code).toBe(
        "payment_details_missing",
      );
      expect((await noticesOf(c, student)).length).toBe(notices);
    }));

  it("changes nothing and tells nobody when the details are the same", () =>
    inRollback(db, async (c) => {
      await save(c, { ...UPI_ONLY, qr: { bytes: PNG, mime: "image/png" } });
      await ageRow(c);
      const student = await insertStudent(c);

      for (const same of [
        { ...UPI_ONLY, qr: { bytes: Buffer.from(PNG), mime: "image/png" as const } },
        { ...UPI_ONLY, qr: "keep" as const },
      ]) {
        const saved = await save(c, same);
        expect(saved.updatedAt).toBe(OLD);
      }
      expect(await noticesOf(c, student)).toEqual([]);
    }));

  it("counts any one difference as a change: it moves updated_at and tells the students", () =>
    inRollback(db, async (c) => {
      const base: PaymentChange = { ...UPI_ONLY, qr: { bytes: PNG, mime: "image/png" } };
      const student = await insertStudent(c);
      const changes: [string, PaymentChange][] = [
        ["UPI ID", { ...base, upiId: "owner@ybl" }],
        ["payee name", { ...base, upiPayeeName: "Lakshmi Hostel" }],
        ["payee name cleared", { ...base, upiPayeeName: null }],
        ["QR bytes", { ...base, qr: { bytes: Buffer.concat([PNG, Buffer.from([0])]), mime: "image/png" } }],
        ["QR type", { ...base, qr: { bytes: PNG, mime: "image/webp" } }],
        ["QR removed", { ...base, qr: null }],
        ["UPI ID removed", { ...base, upiId: null }],
      ];
      for (const [label, change] of changes) {
        await save(c, base);
        await ageRow(c);
        const notices = (await noticesOf(c, student)).length;
        const saved = await save(c, change);
        expect(saved.updatedAt, label).not.toBe(OLD);
        expect((await noticesOf(c, student)).length, label).toBe(notices + 1);
      }
    }));
});

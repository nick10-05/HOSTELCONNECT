import type { PoolClient } from "pg";
import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import type { PhotoType } from "../lib/storage";
import { notify } from "./notifications";

// The owner's payment details (design doc, sections 3, 5 and 9): his UPI ID, payee name
// and an optional QR image, in the one-row hostel_settings table (migration 012). Students
// see them on their fees; changing them notifies every active student.
// tests/paymentSettings.test.ts describes this file.

export type PaymentSettings = {
  upiId: string | null;
  upiPayeeName: string | null;
  // Where the browser fetches the QR image, or null when none is uploaded. It carries the
  // time of the last change, so a new image always has a new address and the old one can
  // be cached for as long as the browser likes.
  qrUrl: string | null;
  updatedAt: string | null; // ISO time of the last change; null before the first save
};

export type PaymentQr = { bytes: Buffer; mime: PhotoType };

// A save: the UPI ID and payee name replace the saved ones (null clears them); the QR is
// replaced by an image, removed by null, or left as it is by "keep".
export type PaymentChange = {
  upiId: string | null;
  upiPayeeName: string | null;
  qr: PaymentQr | null | "keep";
};

export const PAYMENT_QR_PATH = "/api/settings/payment/qr";
export const PAYMENT_SETTINGS_LINK = "/fees";

// The saved details, or every field null before the first save. Read-only.
export async function getPaymentSettings(db: Queryable): Promise<PaymentSettings> {
  const { rows } = await db.query<{
    upiId: string | null;
    upiPayeeName: string | null;
    hasQr: boolean;
    updatedAt: Date;
  }>(
    `SELECT upi_id AS "upiId", upi_payee_name AS "upiPayeeName", qr_image IS NOT NULL AS "hasQr",
            updated_at AS "updatedAt"
     FROM hostel_settings
     WHERE hostel_id = current_hostel_id()`,
  );
  const r = rows[0];
  if (!r) return { upiId: null, upiPayeeName: null, qrUrl: null, updatedAt: null };
  return {
    upiId: r.upiId,
    upiPayeeName: r.upiPayeeName,
    qrUrl: r.hasQr ? `${PAYMENT_QR_PATH}?v=${r.updatedAt.getTime()}` : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

// The uploaded QR image, or null when there is none. Read-only.
export async function getPaymentQr(db: Queryable): Promise<PaymentQr | null> {
  const { rows } = await db.query<PaymentQr>(
    `SELECT qr_image AS bytes, qr_mime AS mime FROM hostel_settings WHERE qr_image IS NOT NULL AND hostel_id = current_hostel_id()`,
  );
  return rows[0] ?? null;
}

// Saves `change`, all or nothing, and returns the details as they are now.
//   - 400 payment_details_missing "Add a UPI ID or a QR image." when neither a UPI ID nor
//     a QR image would be left (section 3: at least one of the two).
//   - When anything differs from what is saved, updated_at moves to now and every active
//     student gets a notification: type 'payment_update', title "The hostel's payment
//     details have changed.", body null, link PAYMENT_SETTINGS_LINK, no dedup key (each
//     change is news). A save that changes nothing changes nothing and notifies nobody.
// The first save creates the row; later ones update it. Two saves at once are applied one
// after the other (the row is locked, or the insert waits for the other's).
export async function savePaymentSettings(db: Db, change: PaymentChange): Promise<PaymentSettings> {
  return inTransaction(db, async (c) => {
    // FOR UPDATE: a second save waits here until this one commits, then compares against
    // what this one saved. Before the first save there is no row to lock; two first saves
    // then meet at the insert below, and the second updates the first's row.
    const { rows } = await c.query<{
      upiId: string | null;
      upiPayeeName: string | null;
      qrImage: Buffer | null;
      qrMime: PhotoType | null;
    }>(
      `SELECT upi_id AS "upiId", upi_payee_name AS "upiPayeeName", qr_image AS "qrImage", qr_mime AS "qrMime"
       FROM hostel_settings
       WHERE hostel_id = current_hostel_id()
       FOR UPDATE`,
    );
    const saved = rows[0] ?? null;
    const savedQr = saved?.qrImage ? { bytes: saved.qrImage, mime: saved.qrMime! } : null;
    const qr = change.qr === "keep" ? savedQr : change.qr;

    if (change.upiId === null && qr === null) {
      throw new HttpError(400, "payment_details_missing", "Add a UPI ID or a QR image.");
    }
    const unchanged =
      saved !== null &&
      saved.upiId === change.upiId &&
      saved.upiPayeeName === change.upiPayeeName &&
      sameQr(savedQr, qr);
    if (unchanged) return getPaymentSettings(c);

    await c.query(
      `INSERT INTO hostel_settings (upi_id, upi_payee_name, qr_image, qr_mime, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET upi_id = EXCLUDED.upi_id,
             upi_payee_name = EXCLUDED.upi_payee_name,
             qr_image = EXCLUDED.qr_image,
             qr_mime = EXCLUDED.qr_mime,
             updated_at = EXCLUDED.updated_at`,
      [change.upiId, change.upiPayeeName, qr?.bytes ?? null, qr?.mime ?? null],
    );
    await notify(c, "active_students", {
      type: "payment_update",
      title: "The hostel's payment details have changed.",
      body: null,
      link: PAYMENT_SETTINGS_LINK,
    });
    return getPaymentSettings(c);
  });
}

// ---- Helpers ----

function sameQr(a: PaymentQr | null, b: PaymentQr | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mime === b.mime && a.bytes.equals(b.bytes);
}

// Runs `fn` in one transaction on its own client: COMMIT when it returns, ROLLBACK when
// it throws (the error is passed on), and the client always goes back to the pool. The
// same helper as in services/announcements.ts.
async function inTransaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  try {
    await c.query("BEGIN");
    transactionStarted = true;
    const result = await fn(c);
    await c.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

import { apiFetch } from "./client";

// The owner's payment details. Shapes match server/src/routes/settings.ts and
// services/paymentSettings.ts. Everyone signed in reads them; only the owner saves them,
// and a save that changes anything notifies every current student.

export type PaymentSettings = {
  upiId: string | null;
  upiPayeeName: string | null;
  // The uploaded QR image's address, or null when none is uploaded. It changes with every
  // save, so the browser may keep each image as long as it likes.
  qrUrl: string | null;
  updatedAt: string | null; // ISO time of the last change; null before the first save
};

// A save: the UPI ID and payee name replace the saved ones (blank clears them). The QR
// image is replaced by `qr`, removed by removeQr, and otherwise kept.
export type PaymentSettingsChange = {
  upiId: string;
  upiPayeeName: string;
  qr?: Blob;
  removeQr?: boolean;
};

// The server's limits.
export const QR_MAX_BYTES = 200 * 1024;
export const UPI_ID_MAX = 255;
export const PAYEE_NAME_MAX = 100;
// Characters as the database counts them (an emoji is one, not two).
export const textLength = (text: string) => [...text.trim()].length;
// One '@' with something on each side and no spaces, as loose as the server's check.
export const looksLikeUpiId = (text: string) => /^[^@\s]+@[^@\s]+$/.test(text.trim());

// GET /api/settings/payment.
export async function getPaymentSettings(): Promise<PaymentSettings> {
  return apiFetch<PaymentSettings>("/api/settings/payment");
}

// PUT /api/settings/payment (owner), as form data so an image can go along. Refusals
// arrive as ApiError: 400 "payment_details_missing" (neither a UPI ID nor a QR image would
// be left), "qr_type", "invalid_input"; 413 "qr_too_large".
export async function savePaymentSettings(change: PaymentSettingsChange): Promise<PaymentSettings> {
  const form = new FormData();
  form.append("upiId", change.upiId.trim());
  form.append("upiPayeeName", change.upiPayeeName.trim());
  if (change.removeQr) form.append("removeQr", "true");
  if (change.qr) form.append("qr", change.qr, "qr");
  return apiFetch<PaymentSettings>("/api/settings/payment", { method: "PUT", body: form });
}

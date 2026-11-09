import { Router } from "express";
import { z } from "zod";
import { parseBody, sendError } from "../lib/http";
import { detectPhotoType } from "../lib/photoType";
import { hostelWork, requireAuth, requireRole, type AuthDeps } from "../middleware/auth";
import { singleFileUpload } from "../middleware/fileUpload";
import { getPaymentQr, getPaymentSettings, savePaymentSettings, type PaymentQr } from "../services/paymentSettings";

// The owner's payment details (design doc, sections 3, 5 and 9). Everyone signed in reads
// them; only the owner saves them (services/paymentSettings.ts notifies the students).

// At most 200 KB, as migration 012 checks it (section 3: the browser compresses it first).
export const QR_MAX_BYTES = 200 * 1024;

// Characters as the database counts them (code points): an emoji is one, not two.
const characters = (s: string) => [...s].length;
// One '@' with something on each side and no whitespace: as loose as migration 012.
const UPI_ID = /^[^@\s]+@[^@\s]+$/;

// Trimmed text; blank means none. Postgres text cannot hold a NUL character, so it is
// refused here rather than failing later.
const optionalText = (check: (s: string) => boolean, message: string) =>
  z
    .string()
    .trim()
    .refine((s) => !s.includes("\u0000"), "contains a character that is not allowed")
    .refine((s) => s === "" || check(s), message)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional();

// PUT /api/settings/payment, as JSON or as the text fields of multipart form data (which
// are always strings, hence removeQr as "true" or "false"). The UPI ID and payee name
// replace the saved ones; blank or missing clears them. The QR image, file "qr", replaces
// the saved one; removeQr removes it; neither keeps it.
export const paymentSettingsSchema = z.strictObject({
  upiId: optionalText((s) => characters(s) <= 255 && UPI_ID.test(s), "must be a UPI ID such as name@bank"),
  upiPayeeName: optionalText((s) => characters(s) <= 100, "can be at most 100 characters"),
  removeQr: z.union([z.boolean(), z.enum(["true", "false"]).transform((s) => s === "true")]).optional(),
});

export function settingsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  // Per route, as in the other routers, so unknown /api paths still get a plain 404.
  const auth = requireAuth(deps);
  const isOwner = requireRole("owner");
  const inHostel = hostelWork(db);
  const qrUpload = singleFileUpload({
    field: "qr",
    maxBytes: QR_MAX_BYTES,
    fields: 3,
    tooLarge: { code: "qr_too_large", what: "The QR image" },
    usage: "qr: send at most one file, named qr, with upiId, upiPayeeName and removeQr",
  });

  // The details change whenever the owner saves them: the browser must always ask again.
  router.get("/settings/payment", auth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await inHostel(req, (tx) => getPaymentSettings(tx)));
  });

  // After the session and role checks, so only the owner's uploads are read.
  router.put("/settings/payment", auth, isOwner, qrUpload, async (req, res) => {
    const body = parseBody(paymentSettingsSchema, req, res);
    if (!body) return;
    let qr: PaymentQr | null | "keep" = body.removeQr ? null : "keep";
    if (req.file) {
      if (body.removeQr) {
        sendError(res, 400, "invalid_input", "removeQr: cannot be sent with a new QR image");
        return;
      }
      const mime = detectPhotoType(req.file.buffer);
      if (!mime) {
        sendError(res, 400, "qr_type", "The QR image must be a JPEG, PNG or WebP image.");
        return;
      }
      qr = { bytes: req.file.buffer, mime };
    }
    res.json(
      await inHostel(req, (tx) =>
        savePaymentSettings(tx, { upiId: body.upiId ?? null, upiPayeeName: body.upiPayeeName ?? null, qr }),
      ),
    );
  });

  // The address from GET /settings/payment carries ?v=<time of the last change>, so a new
  // image always has a new address and this one may be kept for a year. private: it
  // needs a login, so no shared cache may keep it.
  router.get("/settings/payment/qr", auth, async (req, res) => {
    const qr = await inHostel(req, (tx) => getPaymentQr(tx));
    if (!qr) {
      sendError(res, 404, "qr_not_set", "No QR image has been uploaded.");
      return;
    }
    res.set({
      "Content-Type": qr.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(qr.bytes);
  });

  return router;
}

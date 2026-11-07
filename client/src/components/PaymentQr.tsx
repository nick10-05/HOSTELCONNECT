import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { getPaymentSettings, type PaymentSettings } from "../api/settings";
import { upiLink } from "./upiLink";

// The hostel's payment QR (design doc, sections 3 and 9; day 9): the owner's uploaded
// image when there is one; otherwise one drawn in the browser from the UPI ID, holding the
// UPI link with the amount to pay (upiLink). Drawn as an SVG by the qrcode package, shown
// as an image, so nothing is inserted into the page as markup.

const payeeOf = (s: PaymentSettings) => s.upiPayeeName ?? s.upiId ?? "the hostel";

export function PaymentQr({ settings, amount }: { settings: PaymentSettings; amount?: number }) {
  const [drawn, setDrawn] = useState<string | null>(null);
  const link = settings.upiId ? upiLink({ upiId: settings.upiId, upiPayeeName: settings.upiPayeeName }, amount) : null;

  useEffect(() => {
    setDrawn(null);
    if (settings.qrUrl || !link) return;
    let current = true;
    QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" })
      .then((svg) => current && setDrawn(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => current && setDrawn(null));
    return () => {
      current = false;
    };
  }, [settings.qrUrl, link]);

  const src = settings.qrUrl ?? drawn;
  if (!src) return null;
  return (
    <img
      src={src}
      alt={`QR code to pay ${payeeOf(settings)}`}
      className="h-56 w-56 rounded-lg border border-line bg-surface object-contain p-2"
    />
  );
}

// The hostel's payment details for a student (section 9: students "see their balance and
// the UPI ID and QR"): the UPI ID and payee name, the QR, and on phones a link that opens
// a UPI app with the amount filled in. Nothing at all when the details cannot be loaded.
export function PaymentDetails({ amount }: { amount?: number }) {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);

  useEffect(() => {
    let current = true;
    getPaymentSettings()
      .then((s) => current && setSettings(s))
      .catch(() => current && setSettings(null));
    return () => {
      current = false;
    };
  }, []);

  if (!settings) return null;
  const nothingSet = !settings.upiId && !settings.qrUrl;
  return (
    <section
      aria-labelledby="pay-the-hostel"
      className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card"
    >
      <h2 id="pay-the-hostel" className="text-base font-bold text-ink">
        Pay the hostel
      </h2>
      {nothingSet ? (
        <p className="text-sm text-muted">The hostel has not added payment details yet.</p>
      ) : (
        <>
          {settings.upiId && (
            <dl className="space-y-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">UPI ID</dt>
                <dd className="font-mono font-medium break-all text-ink select-all">{settings.upiId}</dd>
              </div>
              {settings.upiPayeeName && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted">Name</dt>
                  <dd className="text-ink">{settings.upiPayeeName}</dd>
                </div>
              )}
            </dl>
          )}
          <PaymentQr settings={settings} amount={amount} />
          {settings.upiId && (
            <a
              href={upiLink({ upiId: settings.upiId, upiPayeeName: settings.upiPayeeName }, amount)}
              className="press bg-active inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold"
            >
              Pay with a UPI app
            </a>
          )}
          <p className="text-sm text-muted">The hostel records your payment, and it shows here once recorded.</p>
        </>
      )}
    </section>
  );
}

import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  getPaymentSettings,
  looksLikeUpiId,
  PAYEE_NAME_MAX,
  savePaymentSettings,
  textLength,
  UPI_ID_MAX,
  type PaymentSettings,
} from "../api/settings";
import { PaymentQr } from "../components/PaymentQr";
import { prepareQr, QrError } from "./prepareQr";
import { inputClass, primaryButton } from "./styles";

// The owner's payment details (design doc, sections 3 and 9; day 9): the UPI ID, the payee
// name and a QR picture, which students see on their fees. At least one of the UPI ID or
// a picture must remain (the server says so if not). Without a picture, students see a QR
// drawn from the UPI ID. A save that changes anything notifies every current student; the
// server tells us whether anything changed (updatedAt moves only then).

const errorText = (err: unknown) =>
  err instanceof ApiError || err instanceof QrError ? err.message : "Something went wrong. Please try again.";

export function SettingsPage() {
  const [saved, setSaved] = useState<PaymentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upiId, setUpiId] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // A new key empties the file field after a save or when the image is to be removed.
  const [fileKey, setFileKey] = useState(0);
  const [removeQr, setRemoveQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upiFieldId = useId();
  const upiHintId = useId();
  const nameFieldId = useId();
  const nameHintId = useId();
  const fileFieldId = useId();
  const removeId = useId();
  const qrHeadingId = useId();

  const show = (s: PaymentSettings) => {
    setSaved(s);
    setUpiId(s.upiId ?? "");
    setPayeeName(s.upiPayeeName ?? "");
    setFile(null);
    setFileKey((k) => k + 1);
    setRemoveQr(false);
  };

  useEffect(() => {
    let current = true;
    getPaymentSettings()
      .then((s) => current && show(s))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);

  const upiBlank = upiId.trim() === "";
  const upiTooLong = textLength(upiId) > UPI_ID_MAX;
  const upiInvalid = !upiBlank && (upiTooLong || !looksLikeUpiId(upiId));
  const nameInvalid = textLength(payeeName) > PAYEE_NAME_MAX;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (upiInvalid || nameInvalid || !saved) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const qr = file ? await prepareQr(file) : undefined;
      const result = await savePaymentSettings({ upiId, upiPayeeName: payeeName, qr, removeQr });
      setMessage(
        result.updatedAt === saved.updatedAt
          ? "Nothing changed, so no one was notified."
          : "Saved. Every current student has been notified.",
      );
      show(result);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        {loadError}
      </p>
    );
  }
  if (!saved) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Payment settings</h1>
        <p className="text-sm text-slate-600">
          Students see these with their fees. Saving a change notifies every current student.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="space-y-1">
          <label htmlFor={upiFieldId} className="block text-sm font-medium text-slate-700">
            UPI ID
          </label>
          <input
            id={upiFieldId}
            value={upiId}
            onChange={(e) => setUpiId(e.target.value)}
            placeholder="name@bank"
            autoComplete="off"
            aria-invalid={upiInvalid}
            aria-describedby={upiHintId}
            className={inputClass}
          />
          <p id={upiHintId} className={`text-xs ${upiInvalid ? "text-red-600" : "text-slate-500"}`}>
            {upiTooLong
              ? `At most ${UPI_ID_MAX} characters.`
              : upiInvalid
                ? "Enter a UPI ID such as name@bank."
                : "Leave it empty to use only a QR picture."}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor={nameFieldId} className="block text-sm font-medium text-slate-700">
            Payee name (optional)
          </label>
          <input
            id={nameFieldId}
            value={payeeName}
            onChange={(e) => setPayeeName(e.target.value)}
            placeholder="As your UPI app shows it"
            aria-invalid={nameInvalid}
            aria-describedby={nameHintId}
            className={inputClass}
          />
          <p id={nameHintId} className={`text-xs ${nameInvalid ? "text-red-600" : "text-slate-500"}`}>
            {nameInvalid ? `At most ${PAYEE_NAME_MAX} characters.` : "Shown to students and filled in by their UPI app."}
          </p>
        </div>

        <section aria-labelledby={qrHeadingId} className="space-y-3">
          <h2 id={qrHeadingId} className="text-sm font-medium text-slate-700">
            QR image
          </h2>
          {saved.qrUrl ? (
            <>
              <PaymentQr settings={saved} />
              <label htmlFor={removeId} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  id={removeId}
                  type="checkbox"
                  checked={removeQr}
                  onChange={(e) => {
                    setRemoveQr(e.target.checked);
                    if (e.target.checked) {
                      setFile(null);
                      setFileKey((k) => k + 1);
                    }
                  }}
                />
                Remove the uploaded image
              </label>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">No image uploaded. Students see a QR code drawn from the UPI ID.</p>
              <PaymentQr settings={saved} />
            </>
          )}
          <div className="space-y-1">
            <label htmlFor={fileFieldId} className="block text-sm font-medium text-slate-700">
              Upload a new QR picture
            </label>
            <input
              key={fileKey}
              id={fileFieldId}
              type="file"
              accept="image/*"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setRemoveQr(false);
              }}
              className="block w-full text-sm text-slate-700"
            />
            <p className="text-xs text-slate-500">A screenshot of your UPI app's QR code works well.</p>
          </div>
        </section>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || upiInvalid || nameInvalid} className={primaryButton}>
          Save
        </button>
      </form>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
    </div>
  );
}

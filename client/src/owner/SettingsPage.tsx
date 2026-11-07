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
import { Skeleton } from "../ui";

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
      <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
        {loadError}
      </p>
    );
  }
  if (!saved) return <Skeleton label="Loading settings…" lines={4} />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Payment settings</h1>
        <p className="text-sm text-muted">
          Students see these with their fees. Saving a change notifies every current student.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5 rounded-card border border-line bg-surface p-4 shadow-card">
        <div className="space-y-1">
          <label htmlFor={upiFieldId} className="block text-sm font-medium text-muted">
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
          <p id={upiHintId} className={`text-xs ${upiInvalid ? "text-danger" : "text-muted"}`}>
            {upiTooLong
              ? `At most ${UPI_ID_MAX} characters.`
              : upiInvalid
                ? "Enter a UPI ID such as name@bank."
                : "Leave it empty to use only a QR picture."}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor={nameFieldId} className="block text-sm font-medium text-muted">
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
          <p id={nameHintId} className={`text-xs ${nameInvalid ? "text-danger" : "text-muted"}`}>
            {nameInvalid ? `At most ${PAYEE_NAME_MAX} characters.` : "Shown to students and filled in by their UPI app."}
          </p>
        </div>

        <section aria-labelledby={qrHeadingId} className="space-y-3">
          <h2 id={qrHeadingId} className="text-sm font-medium text-muted">
            QR image
          </h2>
          {saved.qrUrl ? (
            <>
              <PaymentQr settings={saved} />
              <label htmlFor={removeId} className="flex min-h-11 items-center gap-2 text-sm text-muted">
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
              <p className="text-sm text-muted">No image uploaded. Students see a QR code drawn from the UPI ID.</p>
              <PaymentQr settings={saved} />
            </>
          )}
          <div className="space-y-1">
            <label htmlFor={fileFieldId} className="block text-sm font-medium text-muted">
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
              className="block w-full rounded-2xl border-2 border-dashed border-line bg-soft/50 p-3 text-sm text-muted file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-xl file:border-0 file:bg-surface file:px-4 file:text-sm file:font-semibold file:text-ink file:shadow-card"
            />
            <p className="text-xs text-muted">A screenshot of your UPI app's QR code works well.</p>
          </div>
        </section>

        {error && (
          <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || upiInvalid || nameInvalid} className={primaryButton}>
          Save
        </button>
      </form>

      {message && (
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {message}
        </p>
      )}
    </div>
  );
}

import { useState } from "react";
import { ApiError } from "../api/client";
import { deactivateStudent, type Stay } from "../api/students";
import { hostelToday } from "./admissionForm";
import { formatDate } from "./format";
import { secondaryButton } from "./styles";

// Moving a student out (design doc, section 9), asked on the profile before anything is
// sent: login stops at once and the stay ends; complaints and fees stay.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const dangerButton =
  "press inline-flex min-h-11 items-center justify-center rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60";

export function MoveOutConfirm({
  studentId,
  name,
  stay,
  onDone,
  onCancel,
}: {
  studentId: number;
  name: string;
  stay: Stay | null; // the current stay, if any
  onDone: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A stay that has not started is cancelled rather than ended (decided on day 5).
  const consequence =
    stay && stay.startedOn > hostelToday()
      ? `their booking for ${formatDate(stay.startedOn)} is cancelled`
      : "their stay ends today";

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await deactivateStudent(studentId);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="move-out-heading"
      className="space-y-4 rounded-card border border-red-400/40 bg-surface p-4 shadow-card"
    >
      <h2 id="move-out-heading" className="text-base font-bold text-ink">
        Move out
      </h2>
      <p className="text-muted">
        {`Move out ${name}? They will no longer be able to log in, and ${consequence}.`}
      </p>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={confirm} disabled={busy} className={dangerButton}>
          {busy ? "Moving out…" : "Yes, move out"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </section>
  );
}

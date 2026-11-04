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
  "rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60";

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
      className="space-y-4 rounded-xl border border-red-200 bg-white p-4 shadow-sm"
    >
      <h2 id="move-out-heading" className="text-sm font-semibold text-slate-700">
        Move out
      </h2>
      <p className="text-slate-700">
        {`Move out ${name}? They will no longer be able to log in, and ${consequence}.`}
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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

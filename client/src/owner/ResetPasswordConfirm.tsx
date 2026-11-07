import { useState } from "react";
import { ApiError } from "../api/client";
import { resetStudentPassword } from "../api/students";
import { primaryButton, secondaryButton } from "./styles";

// Resetting a current student's password (design doc, section 5), asked on the profile
// before anything is sent: the old password stops working at once and the student must
// choose a new one at the next login.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function ResetPasswordConfirm({
  studentId,
  name,
  onDone,
  onCancel,
}: {
  studentId: number;
  name: string;
  onDone: (temporaryPassword: string) => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      const { temporaryPassword } = await resetStudentPassword(studentId);
      onDone(temporaryPassword);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="reset-password-heading"
      className="space-y-4 rounded-card border border-amber-400/40 bg-surface p-4 shadow-card"
    >
      <h2 id="reset-password-heading" className="text-base font-bold text-ink">
        Reset password
      </h2>
      <p className="text-muted">
        {`Reset ${name}'s password? Their current password stops working at once, and they must choose a new one when they next log in.`}
      </p>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={confirm} disabled={busy} className={primaryButton}>
          {busy ? "Resetting…" : "Yes, reset password"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </section>
  );
}

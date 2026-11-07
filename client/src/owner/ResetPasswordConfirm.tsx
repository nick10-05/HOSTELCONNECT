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
      className="space-y-4 rounded-xl border border-amber-200 bg-white p-4 shadow-sm"
    >
      <h2 id="reset-password-heading" className="text-sm font-semibold text-slate-700">
        Reset password
      </h2>
      <p className="text-slate-700">
        {`Reset ${name}'s password? Their current password stops working at once, and they must choose a new one when they next log in.`}
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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

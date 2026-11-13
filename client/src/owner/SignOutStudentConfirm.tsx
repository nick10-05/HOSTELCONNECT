import { useState } from "react";
import { ApiError } from "../api/client";
import { signOutStudent } from "../api/students";
import { primaryButton, secondaryButton } from "./styles";

// Signing a student out on every device (security audit), asked on the profile before
// anything is sent: for a student who lost a phone, or whose account someone else may be
// using. The password stays the same, so the student signs in again as usual.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function SignOutStudentConfirm({
  studentId,
  name,
  onDone,
  onCancel,
}: {
  studentId: number;
  name: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await signOutStudent(studentId);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="sign-out-student-heading"
      className="space-y-4 rounded-card border border-amber-400/40 bg-surface p-4 shadow-card"
    >
      <h2 id="sign-out-student-heading" className="text-base font-bold text-ink">
        Sign out everywhere
      </h2>
      <p className="text-muted">
        {`Sign ${name} out on every phone and computer? Their password stays the same, so they can sign in again.`}
      </p>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={confirm} disabled={busy} className={primaryButton}>
          {busy ? "Signing out…" : "Yes, sign out"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </section>
  );
}

import { useId, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { removePassword } from "../api/auth";
import { ApiError } from "../api/client";
import { useAccount } from "../auth/hostel";
import { buttonClass, fieldClass } from "../ui";

// The owner's sign-in settings (multi-tenant phase 3b): link a Google account, then, if
// they like, drop the password and sign in with Google only. Linking goes through Google
// and comes back here with ?google=<outcome>.
const OUTCOMES: Record<string, { text: string; good: boolean }> = {
  linked: { text: "Your Google account is linked. You can now sign in with Google.", good: true },
  taken: { text: "That Google account already signs in to another HostelConnect account.", good: false },
  "already-linked": { text: "A Google account is already linked to this account.", good: false },
  cancelled: { text: "Linking was cancelled at Google. Nothing changed.", good: false },
  failed: { text: "Linking the Google account did not work. Please try again.", good: false },
};

export function GoogleSignIn() {
  const account = useAccount();
  const { search } = useLocation();
  const outcome = OUTCOMES[new URLSearchParams(search).get("google") ?? ""];
  const [passwordRemoved, setPasswordRemoved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const passwordId = useId();

  // Shown only when Google sign-in is set up, or when a Google account is already linked.
  if (!account || (!account.googleEnabled && !account.googleLinked)) return null;
  const hasPassword = account.hasPassword && !passwordRemoved;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removePassword(currentPassword);
      setPasswordRemoved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setCurrentPassword("");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="mx-auto mt-6 max-w-2xl space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id={headingId} className="font-display text-xl font-extrabold tracking-tight text-ink">
        Sign-in
      </h2>
      {outcome && (
        <p role="status" className={`${outcome.good ? "hc-pill-green" : "hc-pill-amber"} rounded-2xl px-3.5 py-3 text-sm font-medium`}>
          {outcome.text}
        </p>
      )}

      {!account.googleLinked ? (
        <>
          <p className="text-sm text-muted">
            Link your Google account to sign in with Google instead of a password.
          </p>
          <a href="/api/auth/google/link" className={`${buttonClass("secondary")} min-h-11`}>
            Link Google account
          </a>
        </>
      ) : hasPassword ? (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-muted">
            Google sign-in is on. You can remove your password: from then on only Google signs you in.
          </p>
          {error && (
            <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
              {error}
            </p>
          )}
          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-muted">
              Current password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={`${fieldClass} mt-1`}
            />
          </div>
          <button type="submit" disabled={busy} className={buttonClass("danger")}>
            {busy ? "Removing…" : "Remove password"}
          </button>
        </form>
      ) : (
        <p role="status" className="text-sm text-muted">
          You sign in with Google only.
        </p>
      )}
    </section>
  );
}

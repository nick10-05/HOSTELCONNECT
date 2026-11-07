import { useState, type FormEvent } from "react";
import { changePassword, type User } from "../api/auth";
import { ApiError } from "../api/client";
import { buttonClass, fieldClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// Same rules as the server, checked here first for instant feedback.
// bcrypt reads only the first 72 bytes, so longer passwords are refused.
export function newPasswordProblem(current: string, next: string, confirm: string): string | null {
  if (next.length < 8) return "The new password must be at least 8 characters.";
  if (new TextEncoder().encode(next).length > 72) return "The new password is too long.";
  if (next === current) return "Choose a new password, not the current one.";
  if (next !== confirm) return "The two new passwords do not match.";
  return null;
}

type Props = {
  user: User;
  onChanged: (user: User) => void;
  onSignOut: () => void;
};

const inputClass = `${fieldClass} mt-1`;

export function ChangePasswordPage({ user, onChanged, onSignOut }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const problem = newPasswordProblem(current, next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onChanged(await changePassword(current, next));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Choose your password" subtitle={`Hi ${user.name}. Replace the temporary password before you continue.`}>

        <form
          onSubmit={handleSubmit}
          noValidate
          className={authCardClass}
        >
          {error && (
            <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="current" className="block text-sm font-semibold text-ink">
              Current (temporary) password
            </label>
            <input
              id="current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="new" className="block text-sm font-semibold text-ink">
              New password
            </label>
            <input
              id="new"
              type="password"
              autoComplete="new-password"
              aria-describedby="new-hint"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputClass}
            />
            <p id="new-hint" className="mt-1 text-xs text-muted">
              At least 8 characters.
            </p>
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm font-semibold text-ink">
              New password again
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className={`${buttonClass("primary")} min-h-12 w-full`}
          >
            {submitting ? "Saving…" : "Save new password"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm">
          <button type="button" onClick={onSignOut} className="min-h-11 px-2 font-semibold text-muted hover:text-ink">
            Sign out
          </button>
        </p>
    </AuthShell>
  );
}

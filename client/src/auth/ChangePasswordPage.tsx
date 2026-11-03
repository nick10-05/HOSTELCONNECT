import { useState, type FormEvent } from "react";
import { changePassword, type User } from "../api/auth";
import { ApiError } from "../api/client";

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

const inputClass =
  "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";

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
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-slate-900">
          Choose your password
        </h1>
        <p className="mt-1 text-center text-sm text-slate-500">
          Hi {user.name}. Replace the temporary password before you continue.
        </p>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="mt-8 space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="current" className="block text-sm font-medium text-slate-700">
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
            <label htmlFor="new" className="block text-sm font-medium text-slate-700">
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
            <p id="new-hint" className="mt-1 text-xs text-slate-500">
              At least 8 characters.
            </p>
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm font-medium text-slate-700">
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
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save new password"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm">
          <button type="button" onClick={onSignOut} className="text-slate-500 hover:text-slate-700">
            Sign out
          </button>
        </p>
      </div>
    </main>
  );
}

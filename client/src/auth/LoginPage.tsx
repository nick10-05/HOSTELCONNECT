import { useEffect, useState, type FormEvent } from "react";
import { login, type User } from "../api/auth";
import { ApiError } from "../api/client";
import { buttonClass, fieldClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// The free host sleeps after 15 idle minutes and takes about a minute to wake, so a
// slow first login is normal. After this long, say so instead of looking frozen.
const SLOW_HINT_AFTER_MS = 4000;

type Props = { onLoggedIn: (user: User) => void };

export function LoginPage({ onLoggedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!submitting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [submitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onLoggedIn(await login(email.trim(), password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setPassword("");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your hostel account">

        <form
          onSubmit={handleSubmit}
          className={authCardClass}
        >
          {error && (
            <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-semibold text-ink">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${fieldClass} mt-1`}
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-semibold text-ink">
                Password
              </label>
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-controls="password"
                aria-pressed={showPassword}
                className="-my-2 min-h-11 px-2 text-sm font-semibold text-accent hover:underline"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${fieldClass} mt-1`}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className={`${buttonClass("primary")} min-h-12 w-full`}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          {slow && (
            <p role="status" className="text-center text-sm text-muted">
              The server is waking up. This can take up to a minute.
            </p>
          )}
        </form>

        <p className="mt-8 text-center text-sm text-muted">
          Forgot your password? Ask the hostel owner to reset it.
        </p>
        <p className="mt-2 text-center text-sm text-muted">
          Former student?{" "}
          {/* A plain link, so this page needs no router (and its tests none either). */}
          <a href="/request-access" className="inline-flex min-h-11 items-center px-1 font-semibold text-accent hover:underline">
            Request access
          </a>
        </p>
    </AuthShell>
  );
}

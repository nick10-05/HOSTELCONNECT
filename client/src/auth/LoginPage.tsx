import { useEffect, useState, type FormEvent } from "react";
import { login, type User } from "../api/auth";
import { ApiError } from "../api/client";

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
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-slate-900">
          HostelConnect
        </h1>
        <p className="mt-1 text-center text-sm text-slate-500">Sign in to your hostel account</p>

        <form
          onSubmit={handleSubmit}
          className="mt-8 space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-controls="password"
                aria-pressed={showPassword}
                className="text-sm text-indigo-600 hover:text-indigo-500"
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
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          {slow && (
            <p role="status" className="text-center text-sm text-slate-500">
              The server is waking up. This can take up to a minute.
            </p>
          )}
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Forgot your password? Ask the hostel owner to reset it.
        </p>
      </div>
    </main>
  );
}

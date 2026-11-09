import { useEffect, useState, type FormEvent } from "react";
import { login, type User } from "../api/auth";
import { ApiError } from "../api/client";
import { requestAccessPath, type Hostel } from "../api/hostels";
import { buttonClass, fieldClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// The free host sleeps after 15 idle minutes and takes about a minute to wake, so a
// slow first login is normal. After this long, say so instead of looking frozen.
const SLOW_HINT_AFTER_MS = 4000;

// What Google sign-in came back with (/login?google=…, routes/google.ts on the server).
const GOOGLE_OUTCOMES: Record<string, string> = {
  "no-account": "No HostelConnect owner account uses that Google account. Sign in with your password, then link Google in Settings.",
  inactive: "That account cannot sign in: the account or its hostel is not active.",
  cancelled: "Google sign-in was cancelled.",
  failed: "Google sign-in did not work. Please try again.",
};

// `hostel`: the hostel whose address this page is at, /h/<slug>/login. Without one, the
// page at the old address, which signs in to hostel #1 (until phase 6).
// `googleEnabled`: show "Sign in with Google" (owners, phase 3b); `googleOutcome`: the
// ?google= value Google sign-in came back with.
type Props = {
  onLoggedIn: (user: User) => void;
  hostel?: Hostel & { slug: string };
  googleEnabled?: boolean;
  googleOutcome?: string | null;
};

export function LoginPage({ onLoggedIn, hostel, googleEnabled = false, googleOutcome = null }: Props) {
  const googleMessage = googleOutcome ? GOOGLE_OUTCOMES[googleOutcome] : undefined;
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
      onLoggedIn(await login(email.trim(), password, hostel?.slug));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setPassword("");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle={hostel ? `Sign in to ${hostel.name}` : "Sign in to your hostel account"}>

        <form
          onSubmit={handleSubmit}
          className={authCardClass}
        >
          {(error ?? googleMessage) && (
            <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
              {error ?? googleMessage}
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

          {googleEnabled && (
            <div className="space-y-2 border-t border-line pt-4 text-center">
              <p className="text-sm text-muted">Hostel owner?</p>
              {/* A plain link: the server sends the browser on to Google. */}
              <a href="/api/auth/google/start" className={`${buttonClass("secondary")} min-h-12 w-full`}>
                Sign in with Google
              </a>
            </div>
          )}
        </form>

        <p className="mt-8 text-center text-sm text-muted">
          Forgot your password? Ask the hostel owner to reset it.
        </p>
        <p className="mt-2 text-center text-sm text-muted">
          Former student?{" "}
          {/* A plain link, so this page needs no router (and its tests none either). */}
          <a href={hostel ? requestAccessPath(hostel.slug) : "/request-access"} className="inline-flex min-h-11 items-center px-1 font-semibold text-accent hover:underline">
            Request access
          </a>
        </p>
    </AuthShell>
  );
}

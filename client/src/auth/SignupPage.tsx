import { useEffect, useId, useState, type FormEvent } from "react";
import type { User } from "../api/auth";
import { ApiError } from "../api/client";
import { signInPath } from "../api/hostels";
import { checkSlug, getSignup, isSlug, signUp, SLUG_PROBLEMS, suggestSlug, type SlugCheck } from "../api/signup";
import { buttonClass, fieldClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// Sign-up (multi-tenant phase 4a): a Google account no owner has arrives here from Google
// with a sign-up ticket. The owner names themself and their hostel, chooses the hostel's
// address (students sign in at /h/<address>/login), accepts the terms, and is signed in.
const CHECK_AFTER_MS = 300;

type Loaded =
  | { status: "loading" }
  | { status: "ready"; email: string; termsVersion: string }
  | { status: "not-started" }
  | { status: "closed" }
  | { status: "error"; message: string };

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong. Please try again.");

export function SignupPage({ onSignedUp }: { onSignedUp: (user: User) => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let current = true;
    getSignup()
      .then((s) => current && setLoaded({ status: "ready", ...s }))
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.code === "signup_not_started") setLoaded({ status: "not-started" });
        else if (err instanceof ApiError && err.code === "signups_closed") setLoaded({ status: "closed" });
        else setLoaded({ status: "error", message: errorText(err) });
      });
    return () => {
      current = false;
    };
  }, []);

  if (loaded.status === "loading") {
    return (
      <AuthShell title="Set up your hostel">
        <p role="status" className="mt-8 text-center text-sm text-muted">
          Loading…
        </p>
      </AuthShell>
    );
  }
  if (loaded.status === "ready") return <SignupForm {...loaded} onSignedUp={onSignedUp} />;

  const message =
    loaded.status === "closed"
      ? "New hostels cannot sign up yet."
      : loaded.status === "not-started"
        ? "Start by choosing your Google account. Sign-up takes a couple of minutes."
        : loaded.message;
  return (
    <AuthShell title="Set up your hostel">
      <div className={authCardClass}>
        <p role={loaded.status === "error" ? "alert" : "status"} className="text-sm text-muted">
          {message}
        </p>
        {loaded.status !== "closed" && (
          <a href="/api/auth/google/start" className={`${buttonClass("primary")} min-h-12 w-full`}>
            Continue with Google
          </a>
        )}
        <a href="/login" className="block text-center text-sm font-semibold text-accent hover:underline">
          Back to sign in
        </a>
      </div>
    </AuthShell>
  );
}

function SignupForm({
  email,
  termsVersion,
  onSignedUp,
}: {
  email: string;
  termsVersion: string;
  onSignedUp: (user: User) => void;
}) {
  const [ownerName, setOwnerName] = useState("");
  const [hostelName, setHostelName] = useState("");
  const [slug, setSlug] = useState("");
  // The address follows the hostel's name until the owner types one of their own.
  const [slugEdited, setSlugEdited] = useState(false);
  const [check, setCheck] = useState<{ slug: string; result: SlugCheck } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { owner: useId(), hostel: useId(), slug: useId(), slugHint: useId(), terms: useId() };

  const address = slugEdited ? slug : suggestSlug(hostelName);

  // Ask the server whether the address is free, once typing pauses.
  useEffect(() => {
    if (!isSlug(address)) return;
    let current = true;
    const timer = setTimeout(() => {
      checkSlug(address)
        .then((result) => current && setCheck({ slug: address, result }))
        .catch(() => undefined);
    }, CHECK_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [address]);

  const known = check?.slug === address ? check.result : undefined;
  const problem =
    address === "" ? null : !isSlug(address) ? SLUG_PROBLEMS.invalid : known && !known.available ? SLUG_PROBLEMS[known.reason] : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || problem || !accepted) return;
    setBusy(true);
    setError(null);
    try {
      onSignedUp(await signUp({ ownerName, hostelName, slug: address, termsVersion }));
    } catch (err) {
      if (err instanceof ApiError && err.code === "slug_taken") setCheck({ slug: address, result: { available: false, reason: "taken" } });
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Set up your hostel" subtitle={`Signing up as ${email}`}>
      <form onSubmit={submit} className={authCardClass}>
        {error && (
          <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
            {error}
          </p>
        )}

        <div>
          <label htmlFor={ids.owner} className="block text-sm font-semibold text-ink">
            Your name
          </label>
          <input
            id={ids.owner}
            autoComplete="name"
            required
            maxLength={100}
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div>
          <label htmlFor={ids.hostel} className="block text-sm font-semibold text-ink">
            Hostel name
          </label>
          <input
            id={ids.hostel}
            autoComplete="organization"
            required
            maxLength={100}
            value={hostelName}
            onChange={(e) => setHostelName(e.target.value)}
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div>
          <label htmlFor={ids.slug} className="block text-sm font-semibold text-ink">
            Hostel address
          </label>
          <input
            id={ids.slug}
            required
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            value={address}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"));
            }}
            aria-invalid={problem ? true : undefined}
            aria-describedby={ids.slugHint}
            className={`${fieldClass} mt-1`}
          />
          <p id={ids.slugHint} aria-live="polite" className={`mt-1 text-sm ${problem ? "text-danger" : "text-muted"}`}>
            {problem ??
              (address
                ? `Students will sign in at ${window.location.origin}${signInPath(address)}${known?.available ? " (free)" : ""}`
                : "Students sign in at this address. You can change it later.")}
          </p>
        </div>

        <div className="flex items-start gap-3">
          <input
            id={ids.terms}
            type="checkbox"
            required
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-1 size-5 shrink-0"
          />
          <label htmlFor={ids.terms} className="text-sm text-ink">
            I accept the{" "}
            <a href="/terms" target="_blank" rel="noopener" className="font-semibold text-accent hover:underline">
              Terms of Service
            </a>{" "}
            and the{" "}
            <a href="/privacy" target="_blank" rel="noopener" className="font-semibold text-accent hover:underline">
              Privacy Policy
            </a>
            , and I will get a parent's or guardian's consent before adding any student under 18.
          </label>
        </div>

        <button type="submit" disabled={busy || problem !== null || !accepted} className={`${buttonClass("primary")} min-h-12 w-full`}>
          {busy ? "Setting up…" : "Create my hostel"}
        </button>
      </form>
    </AuthShell>
  );
}

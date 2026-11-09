import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { getHostel } from "../api/hostels";
import { buttonClass, fieldClass } from "../ui";

// The way to a hostel's own page from an address that names no hostel (multi-tenant
// phase 6): /login and /request-access. Every password sign-in and every request names
// its hostel, because the same email may belong to accounts in two hostels. The visitor
// types their hostel's address (or pastes the whole sign-in link), the hostel is looked
// up, and the browser goes to its page, `pathFor(slug)`.

// The address out of what was typed: "sns-hostel", "/h/sns-hostel/login" or a whole link.
export function slugFrom(typed: string): string {
  const text = typed.trim().toLowerCase();
  const inLink = /\/h\/([^/?#\s]+)/.exec(text);
  return (inLink ? inLink[1] : text).replace(/^\/+|\/+$/g, "");
}

const NOT_FOUND = "No hostel has this address. Check it with your hostel owner.";

export function FindHostel({
  pathFor,
  goTo = (path) => window.location.assign(path),
}: {
  pathFor: (slug: string) => string;
  // How the browser moves on; tests pass their own.
  goTo?: (path: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const slug = slugFrom(typed);
    if (!slug) {
      setError("Enter your hostel's address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hostel = await getHostel(slug);
      goTo(pathFor(hostel.slug ?? slug));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? NOT_FOUND
          : err instanceof ApiError
            ? err.message
            : "Something went wrong. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="hostel-address" className="block text-sm font-semibold text-ink">
          Your hostel's address
        </label>
        <input
          id="hostel-address"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="e.g. sns-hostel"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-describedby="hostel-address-hint"
          aria-invalid={error ? true : undefined}
          className={`${fieldClass} mt-1`}
        />
        <p id="hostel-address-hint" className="mt-1 text-sm text-muted">
          It is in your sign-in link, after /h/. Your hostel owner can tell you.
        </p>
      </div>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${buttonClass("primary")} min-h-12 w-full`}>
        {busy ? "Finding…" : "Continue"}
      </button>
    </form>
  );
}

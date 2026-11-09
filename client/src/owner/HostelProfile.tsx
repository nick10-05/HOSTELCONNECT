import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { signInPath, updateHostel, type Hostel } from "../api/hostels";
import { isSlug, SLUG_PROBLEMS } from "../api/signup";
import { useHostel } from "../auth/hostel";
import { buttonClass, fieldClass } from "../ui";

// The owner's hostel (multi-tenant phase 4a): its name, and its address, where students
// sign in. A new address changes every student's sign-in link, so the page says so first.
export function HostelProfile({ onSaved }: { onSaved: (hostel: Hostel) => void }) {
  const hostel = useHostel();
  const [name, setName] = useState(hostel?.name ?? "");
  const [slug, setSlug] = useState(hostel?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { heading: useId(), name: useId(), slug: useId(), slugHint: useId() };

  if (!hostel) return null;
  const nameChanged = name.trim() !== hostel.name;
  const slugChanged = slug !== (hostel.slug ?? "");
  const slugProblem = slugChanged && !isSlug(slug) ? SLUG_PROBLEMS.invalid : null;
  const link = (s: string) => `${window.location.origin}${signInPath(s)}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || slugProblem || (!nameChanged && !slugChanged)) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await updateHostel({ ...(nameChanged && { name }), ...(slugChanged && { slug }) });
      setName(saved.name);
      setSlug(saved.slug ?? "");
      onSaved(saved);
      setMessage(slugChanged ? "Saved. Send your students the new sign-in link." : "Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={ids.heading} className="mx-auto mt-6 max-w-2xl rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id={ids.heading} className="font-display text-xl font-extrabold tracking-tight text-ink">
        Hostel
      </h2>
      <form onSubmit={submit} className="mt-3 space-y-4">
        {message && (
          <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
            {error}
          </p>
        )}
        <div>
          <label htmlFor={ids.name} className="block text-sm font-medium text-muted">
            Name
          </label>
          <input
            id={ids.name}
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div>
          <label htmlFor={ids.slug} className="block text-sm font-medium text-muted">
            Address
          </label>
          <input
            id={ids.slug}
            required
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            aria-invalid={slugProblem ? true : undefined}
            aria-describedby={ids.slugHint}
            className={`${fieldClass} mt-1`}
          />
          <p id={ids.slugHint} className={`mt-1 text-sm ${slugProblem ? "text-danger" : "text-muted"}`}>
            {slugProblem ??
              (slugChanged
                ? `Students' sign-in link becomes ${link(slug)}. The old link, ${link(hostel.slug ?? "")}, stops working.`
                : hostel.slug
                  ? `Students sign in at ${link(hostel.slug)}`
                  : "Choose the address where your students sign in.")}
          </p>
        </div>
        <button
          type="submit"
          disabled={busy || slugProblem !== null || (!nameChanged && !slugChanged)}
          className={buttonClass(slugChanged ? "danger" : "primary")}
        >
          {busy ? "Saving…" : slugChanged ? "Change address" : "Save"}
        </button>
      </form>
    </section>
  );
}

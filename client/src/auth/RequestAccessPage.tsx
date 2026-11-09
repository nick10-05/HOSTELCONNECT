import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { requestAccessPath, signInPath, type Hostel } from "../api/hostels";
import { requestAccess } from "../api/rejoin";
import { buttonClass, fieldClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";
import { FindHostel } from "./FindHostel";

// The public "Request access" page (design doc, section 9), for former students, who
// cannot log in. The server answers the same sentence whoever the email belongs to, and
// this page shows exactly that sentence: it never says whether the email was known.

export const MESSAGE_LIMIT = 500;

const inputClass = `${fieldClass} mt-1`;

// `hostel`: the hostel whose address this page is at, /h/<slug>/request-access. Without
// one (/request-access), the page asks for the hostel's address first (phase 6).
export function RequestAccessPage({ hostel }: { hostel?: Hostel & { slug: string } } = {}) {
  if (!hostel) {
    return (
      <AuthShell title="Request access" subtitle="Find your hostel first">
        <div className={authCardClass}>
          <FindHostel pathFor={requestAccessPath} />
        </div>
        <p className="mt-6 text-center text-sm">
          <a href="/" className="inline-flex min-h-11 items-center px-1 font-semibold text-accent hover:underline">
            Back to sign in
          </a>
        </p>
      </AuthShell>
    );
  }
  return <RequestAccessForm hostel={hostel} />;
}

function RequestAccessForm({ hostel }: { hostel: Hostel & { slug: string } }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  // Counted as characters, as the server and the database count them (an emoji is one).
  const length = [...message.trim()].length;
  const tooLong = length > MESSAGE_LIMIT;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || tooLong) return;
    setSubmitting(true);
    setError(null);
    try {
      setAnswer(await requestAccess(email.trim(), message.trim(), hostel.slug));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Request access"
      subtitle={`For former residents of ${hostel.name} who would like to come back`}
    >

        {answer ? (
          <div className={`${authCardClass} space-y-4`}>
            <p role="status" className="font-semibold text-ink">
              {answer}
            </p>
            <p className="text-sm text-muted">
              If your request is approved, the owner will give you a temporary password in person.
            </p>
          </div>
        ) : (
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
              <label htmlFor="request-email" className="block text-sm font-semibold text-ink">
                Email you used at the hostel
              </label>
              <input
                id="request-email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="request-message" className="block text-sm font-semibold text-ink">
                Message for the owner (optional)
              </label>
              <textarea
                id="request-message"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-describedby="request-message-count"
                aria-invalid={tooLong ? true : undefined}
                className={`${inputClass} aria-invalid:border-red-400`}
              />
              <p
                id="request-message-count"
                className={`mt-1 text-right text-sm ${tooLong ? "font-semibold text-danger" : "text-muted"}`}
              >
                {length} / {MESSAGE_LIMIT}
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting || tooLong}
              className={`${buttonClass("primary")} min-h-12 w-full`}
            >
              {submitting ? "Sending…" : "Send request"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm">
          {/* A plain link: the sign-in page is the same app, loaded fresh. */}
          <a href={signInPath(hostel.slug)} className="inline-flex min-h-11 items-center px-1 font-semibold text-accent hover:underline">
            Back to sign in
          </a>
        </p>
    </AuthShell>
  );
}

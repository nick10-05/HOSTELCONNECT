import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { requestAccess } from "../api/rejoin";

// The public "Request access" page (design doc, section 9), for former students, who
// cannot log in. The server answers the same sentence whoever the email belongs to, and
// this page shows exactly that sentence: it never says whether the email was known.

export const MESSAGE_LIMIT = 500;

const inputClass =
  "mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";

export function RequestAccessPage() {
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
      setAnswer(await requestAccess(email.trim(), message.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-slate-900">Request access</h1>
        <p className="mt-1 text-center text-sm text-slate-500">
          For former residents who would like to come back
        </p>

        {answer ? (
          <div className="mt-8 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p role="status" className="text-slate-700">
              {answer}
            </p>
            <p className="text-sm text-slate-500">
              If your request is approved, the owner will give you a temporary password in person.
            </p>
          </div>
        ) : (
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
              <label htmlFor="request-email" className="block text-sm font-medium text-slate-700">
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
              <label htmlFor="request-message" className="block text-sm font-medium text-slate-700">
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
                className={`mt-1 text-right text-sm ${tooLong ? "text-red-700" : "text-slate-500"}`}
              >
                {length} / {MESSAGE_LIMIT}
              </p>
            </div>

            <button
              type="submit"
              disabled={submitting || tooLong}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send request"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm">
          {/* A plain link: the sign-in page is the same app, loaded fresh. */}
          <a href="/" className="font-medium text-indigo-700 hover:underline">
            Back to sign in
          </a>
        </p>
      </div>
    </main>
  );
}

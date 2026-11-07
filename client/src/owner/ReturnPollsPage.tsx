import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
  listPolls,
  POLL_TITLE_MAX,
  startPoll,
  titleLength,
  type PollCounts,
  type PollWithCounts,
} from "../api/returnPolls";
import { formatTime } from "../components/complaintText";
import { inputClass, primaryButton } from "./styles";
import { ListSkeleton, Pager } from "../ui/ListParts";

// The owner's return polls (design doc, sections 2 and 9; day 9): start one with a short
// question, which notifies every current student, and see every poll with its counts.
// Only one poll may be open at a time, so the form is shown only while none is. Each poll
// opens its results page. The page number is in the address.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";


export const countsText = (c: PollCounts) =>
  `${c.returned} returned · ${c.notYet} not yet · ${c.noResponse} no response`;

export function PollStatusBadge({ status }: { status: PollWithCounts["status"] }) {
  return status === "open" ? (
    <span className="rounded-full hc-pill-green px-2 py-0.5 text-xs font-semibold">Open</span>
  ) : (
    <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-semibold text-muted">Closed</span>
  );
}

export function ReturnPollsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [result, setResult] = useState<{ items: PollWithCounts[]; total: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoadError(null);
    listPolls(page)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, [page, reloads]);

  // The list is newest first, so an open poll is on the first page; on a later page the
  // form stays hidden rather than guessing.
  const anyOpen = result ? page > 1 || result.items.some((p) => p.status === "open") : true;
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Return polls</h1>

      {result &&
        (anyOpen ? (
          page === 1 && <p className="text-sm text-muted">Close the open poll before starting another.</p>
        ) : (
          <StartForm
            onStarted={() => {
              setMessage("Poll started. Every current student has been notified.");
              setReloads((n) => n + 1);
            }}
          />
        ))}

      {message && (
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {message}
        </p>
      )}

      {loadError ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {loadError}
        </p>
      ) : !result ? (
        <ListSkeleton label="Loading polls…" rows={3} />
      ) : result.total === 0 ? (
        <p className="text-sm text-muted">No return polls yet.</p>
      ) : (
        <>
          <ul aria-label="Return polls" className="space-y-3">
            {result.items.map((p) => (
              <li key={p.id} className="space-y-1 rounded-card border border-line bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/return-polls/${p.id}`} className="-my-2.5 inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
                    {p.title}
                  </Link>
                  <PollStatusBadge status={p.status} />
                </div>
                <p className="text-sm text-muted">{countsText(p.counts)}</p>
                <p className="text-xs text-muted">
                  Started {formatTime(p.createdAt)}
                  {p.closedAt && ` · closed ${formatTime(p.closedAt)}`}
                </p>
              </li>
            ))}
          </ul>
          <Pager page={page} pages={pages} onPage={(n) => setParams(n > 1 ? { page: String(n) } : {})} />
        </>
      )}
    </div>
  );
}

function StartForm({ onStarted }: { onStarted: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const countId = useId();

  const length = titleLength(title);
  const tooLong = length > POLL_TITLE_MAX;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (length === 0 || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await startPoll(title.trim());
      // The list reloads with the new poll open, which hides this form.
      onStarted();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 className="text-base font-bold text-ink">New poll</h2>
      <div className="space-y-1">
        <label htmlFor={fieldId} className="block text-sm font-medium text-muted">
          Question
        </label>
        <input
          id={fieldId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Back after the holidays?"
          aria-invalid={tooLong}
          aria-describedby={countId}
          className={inputClass}
        />
        <p id={countId} className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
          {length} / {POLL_TITLE_MAX}
        </p>
      </div>
      <p className="text-sm text-muted">Every current student is notified and answers from their home page.</p>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || length === 0 || tooLong} className={primaryButton}>
        Start poll
      </button>
    </form>
  );
}

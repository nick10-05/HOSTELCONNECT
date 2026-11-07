import { useEffect, useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { closePoll, getPollResults, type PollResults, type PollStudent } from "../api/returnPolls";
import { getStructure, type Building } from "../api/structure";
import { formatTime } from "../components/complaintText";
import { PollStatusBadge } from "./ReturnPollsPage";
import { inputClass, secondaryButton } from "./styles";
import { Skeleton } from "../ui";
import { backLinkClass } from "../ui/ListParts";

// One return poll's results (design doc, section 9; day 9): who has returned, who has not
// yet and who has not answered, among the students who are active now, for all buildings
// or one (kept in the address as ?building=). The owner closes an open poll here, after
// confirming, since closing is final. The food counts can count only those who returned.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const placeText = (s: PollStudent) =>
  [s.buildingName, s.roomNumber && `Room ${s.roomNumber}`].filter(Boolean).join(" · ");

export function ReturnPollPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const building = params.get("building") ?? "";

  const [data, setData] = useState<PollResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [reloads, setReloads] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const buildingId = useId();

  useEffect(() => {
    let current = true;
    setError(null);
    getPollResults(id, building ? Number(building) : undefined)
      .then((d) => current && setData(d))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [id, building, reloads]);

  // Only for the building list; without it the filter is simply not offered.
  useEffect(() => {
    let current = true;
    getStructure()
      .then((b) => current && setBuildings(b))
      .catch(() => current && setBuildings([]));
    return () => {
      current = false;
    };
  }, []);

  const close = async () => {
    setBusy(true);
    setMessage(null);
    setActionError(null);
    try {
      await closePoll(id);
      setConfirming(false);
      setMessage("Poll closed.");
      setReloads((n) => n + 1);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Link to="/return-polls" className={backLinkClass}>
          ← Return polls
        </Link>
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      </div>
    );
  }
  if (!data) return <Skeleton label="Loading the poll…" lines={4} />;

  const { poll, counts } = data;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link to="/return-polls" className={backLinkClass}>
        ← Return polls
      </Link>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">{poll.title}</h1>
          <PollStatusBadge status={poll.status} />
        </div>
        <p className="text-sm text-muted">
          Started {formatTime(poll.createdAt)}
          {poll.closedAt && ` · closed ${formatTime(poll.closedAt)}`}
        </p>
      </div>

      {message && (
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {buildings.length > 0 && (
          <div className="space-y-1">
            <label htmlFor={buildingId} className="block text-sm font-medium text-muted">
              Building
            </label>
            <select
              id={buildingId}
              value={building}
              onChange={(e) => setParams(e.target.value ? { building: e.target.value } : {})}
              className={inputClass}
            >
              <option value="">All buildings</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Link to={`/food-counts?pollId=${poll.id}`} className={secondaryButton}>
          Food counts for those who returned
        </Link>
        {poll.status === "open" && !confirming && (
          <button type="button" className={secondaryButton} onClick={() => setConfirming(true)}>
            Close poll
          </button>
        )}
      </div>

      {confirming && (
        <div role="group" aria-label="Confirm close" className="hc-pill-amber space-y-2 rounded-2xl p-3">
          <p className="text-sm">
            Students can no longer answer once it is closed. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void close()}
              className="press inline-flex min-h-10 items-center justify-center rounded-xl bg-strong px-3 text-sm font-semibold text-strong-ink disabled:opacity-60"
            >
              Yes, close it
            </button>
            <button type="button" className={secondaryButton} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <StudentList title="Returned" count={counts.returned} students={data.returned} />
      <StudentList title="Not yet" count={counts.notYet} students={data.notYet} />
      <StudentList title="No response" count={counts.noResponse} students={data.noResponse} />
    </div>
  );
}

function StudentList({
  title,
  count,
  students,
}: {
  title: string;
  count: number;
  students: (PollStudent & { respondedAt?: string })[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id={headingId} className="text-base font-bold text-ink">
        {title} ({count})
      </h2>
      {students.length === 0 ? (
        <p className="text-sm text-muted">Nobody.</p>
      ) : (
        <ul className="divide-y divide-line">
          {students.map((s) => (
            <li key={s.studentId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
              <span>
                <Link to={`/students/${s.studentId}`} className="-my-3 inline-flex min-h-11 items-center font-medium text-ink hover:underline">
                  {s.name}
                </Link>
                <span className="block text-sm text-muted">{placeText(s)}</span>
              </span>
              {s.respondedAt && <span className="text-xs text-muted">{formatTime(s.respondedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { useEffect, useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { closePoll, getPollResults, type PollResults, type PollStudent } from "../api/returnPolls";
import { getStructure, type Building } from "../api/structure";
import { formatTime } from "../components/complaintText";
import { PollStatusBadge } from "./ReturnPollsPage";
import { inputClass, secondaryButton } from "./styles";

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
        <Link to="/return-polls" className="text-sm font-medium text-indigo-700 hover:underline">
          ← Return polls
        </Link>
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  const { poll, counts } = data;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link to="/return-polls" className="text-sm font-medium text-indigo-700 hover:underline">
        ← Return polls
      </Link>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900">{poll.title}</h1>
          <PollStatusBadge status={poll.status} />
        </div>
        <p className="text-sm text-slate-500">
          Started {formatTime(poll.createdAt)}
          {poll.closedAt && ` · closed ${formatTime(poll.closedAt)}`}
        </p>
      </div>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        {buildings.length > 0 && (
          <div className="space-y-1">
            <label htmlFor={buildingId} className="block text-sm font-medium text-slate-700">
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
        <div role="group" aria-label="Confirm close" className="space-y-2 rounded-lg bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            Students can no longer answer once it is closed. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void close()}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
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
    <section aria-labelledby={headingId} className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 id={headingId} className="text-sm font-semibold text-slate-700">
        {title} ({count})
      </h2>
      {students.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {students.map((s) => (
            <li key={s.studentId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
              <span>
                <Link to={`/students/${s.studentId}`} className="font-medium text-slate-900 hover:underline">
                  {s.name}
                </Link>
                <span className="block text-sm text-slate-500">{placeText(s)}</span>
              </span>
              {s.respondedAt && <span className="text-xs text-slate-500">{formatTime(s.respondedAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

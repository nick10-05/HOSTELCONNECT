import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_PRIORITIES,
  COMPLAINT_STATUSES,
  listOwnerComplaints,
  OWNER_FILTERS,
  type OwnerComplaintItem,
  type OwnerComplaintQuery,
} from "../api/complaints";
import { getStructure, type Building } from "../api/structure";
import {
  categoryLabel,
  formatTime,
  PriorityBadge,
  priorityLabel,
  StatusBadge,
  statusLabel,
} from "../components/complaintText";
import { inputClass } from "./styles";

// The owner's complaint list (design doc, sections 5 and 9): every student's complaints,
// active first, high priority first, oldest first, as the server orders them. Every filter
// lives in the page address (/complaints?status=open&page=2), so Back, refresh and a
// bookmark all show the same list, as on the Students page.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

// Only the first line of the description, so each row stays one line on a phone.
const firstLine = (text: string) => text.split("\n")[0];

export function ComplaintsPage() {
  const [params, setParams] = useSearchParams();
  const query: OwnerComplaintQuery = Object.fromEntries(
    OWNER_FILTERS.flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : [])),
  );
  const queryKey = JSON.stringify(query);

  const [buildings, setBuildings] = useState<Building[]>([]);
  const [result, setResult] = useState<{ items: OwnerComplaintItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStructure()
      .then(setBuildings)
      .catch(() => setBuildings([]));
  }, []);

  useEffect(() => {
    let current = true;
    setError(null);
    listOwnerComplaints(query)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setError(errorText(err)));
    // Ignore an answer that arrives after the owner has already changed the filters.
    return () => {
      current = false;
    };
    // queryKey stands for query: a new object every render, but the same text.
  }, [queryKey]);

  // Changes one filter and goes back to page 1. Empty values leave the address.
  const update = (changes: OwnerComplaintQuery) => {
    const next = { ...query, ...changes, page: undefined };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>);
  };

  const goToPage = (page: number) => setParams({ ...(query as Record<string, string>), page: String(page) });

  const page = Number(query.page ?? "1");
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const filtered = OWNER_FILTERS.some((key) => key !== "page" && query[key]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Complaints</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Filter label="Status" value={query.status} onChange={(v) => update({ status: v })}>
          <option value="">All statuses</option>
          {COMPLAINT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel[s]}
            </option>
          ))}
        </Filter>
        <Filter label="Priority" value={query.priority} onChange={(v) => update({ priority: v })}>
          <option value="">All priorities</option>
          {COMPLAINT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabel[p]}
            </option>
          ))}
        </Filter>
        <Filter label="Category" value={query.category} onChange={(v) => update({ category: v })}>
          <option value="">All categories</option>
          {COMPLAINT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel[c]}
            </option>
          ))}
        </Filter>
        <Filter label="Building" value={query.buildingId} onChange={(v) => update({ buildingId: v })}>
          <option value="">All buildings</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Filter>
        <DateFilter label="From" value={query.from} onChange={(v) => update({ from: v })} />
        <DateFilter label="To" value={query.to} onChange={(v) => update({ to: v })} />
      </div>

      {filtered && (
        <button
          type="button"
          onClick={() => setParams({})}
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          Clear filters
        </button>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {result === null ? (
        !error && <p className="text-sm text-slate-500">Loading…</p>
      ) : result.total === 0 ? (
        <p className="text-sm text-slate-600">
          {filtered ? "No complaints match these filters." : "No complaints yet."}
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {result.total} {result.total === 1 ? "complaint" : "complaints"}
          </p>
          <ul
            aria-label="Complaints"
            className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            {result.items.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    to={`/complaints/${c.id}`}
                    className="font-medium text-slate-900 hover:text-indigo-700 hover:underline"
                  >
                    {categoryLabel[c.category]} #{c.id}
                  </Link>
                  <p className="truncate text-sm text-slate-700">{firstLine(c.description)}</p>
                  <p className="text-sm text-slate-500">
                    {c.student.name} ·{" "}
                    {c.place
                      ? [c.place.buildingName, c.place.roomNumber && `Room ${c.place.roomNumber}`]
                          .filter(Boolean)
                          .join(" · ")
                      : "Moved out"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:w-56 sm:flex-col sm:items-end">
                  <div className="flex gap-2">
                    <StatusBadge status={c.status} />
                    <PriorityBadge priority={c.priority} />
                  </div>
                  <p className="text-xs text-slate-500">Raised {formatTime(c.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <button type="button" className={pageButton} disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {page} of {pages}
              </span>
              <button
                type="button"
                className={pageButton}
                disabled={page >= pages}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
        {children}
      </select>
    </div>
  );
}

// A day, as 'YYYY-MM-DD' (the browser's date picker gives exactly that).
function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={inputClass}
      />
    </div>
  );
}

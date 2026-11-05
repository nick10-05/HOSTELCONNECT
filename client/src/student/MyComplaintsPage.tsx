import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { listMyComplaints, type ComplaintList } from "../api/complaints";
import { primaryButton } from "../owner/styles";
import { categoryLabel, formatTime, StatusBadge } from "./complaintText";

// The student's complaints (design doc, section 9): newest first, each opening its
// timeline, and a "New complaint" button that is disabled with the reason shown when the
// active or the 24-hour limit is reached. The page number is in the address.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export function MyComplaintsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [result, setResult] = useState<ComplaintList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    listMyComplaints(page)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [page]);

  const goTo = (next: number) => {
    setResult(null);
    setParams(next > 1 ? { page: String(next) } : {});
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const canRaise = result?.canRaise;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">My complaints</h1>
        {canRaise?.allowed && (
          <Link to="/complaints/new" className={primaryButton}>
            New complaint
          </Link>
        )}
        {canRaise && !canRaise.allowed && (
          <button type="button" disabled aria-describedby="new-complaint-reason" className={primaryButton}>
            New complaint
          </button>
        )}
      </div>

      {canRaise && !canRaise.allowed && (
        <p id="new-complaint-reason" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {canRaise.reason}
        </p>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !result ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : result.total === 0 ? (
        <p className="text-sm text-slate-600">You have not raised any complaints.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {result.items.map((c) => {
              const titleId = `complaint-${c.id}`;
              return (
                <li key={c.id} aria-labelledby={titleId}>
                  <Link
                    to={`/complaints/${c.id}`}
                    className="block space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span id={titleId} className="font-medium text-slate-900">
                        {categoryLabel[c.category]}
                      </span>
                      <StatusBadge status={c.status} />
                    </div>
                    <p className="line-clamp-2 text-sm break-words text-slate-700">{c.description}</p>
                    <p className="text-xs text-slate-500">Raised {formatTime(c.createdAt)}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <button type="button" className={pageButton} disabled={page <= 1} onClick={() => goTo(page - 1)}>
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {page} of {pages}
              </span>
              <button type="button" className={pageButton} disabled={page >= pages} onClick={() => goTo(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

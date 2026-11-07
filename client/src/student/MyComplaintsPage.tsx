import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { listMyComplaints, type ComplaintList } from "../api/complaints";
import { categoryLabel, categoryLook, formatTime, StatusBadge } from "../components/complaintText";
import { Alert, buttonClass, EmptyState, IconTile } from "../ui";
import { ChevronRightIcon, MessageIcon, PlusIcon, WarningIcon } from "../ui/icons";
import { ListSkeleton, Pager } from "../ui/ListParts";

// The student's complaints (design doc, section 9): newest first, each opening its
// timeline, and a "New complaint" button that is disabled with the reason shown when the
// active or the 24-hour limit is reached. The page number is in the address.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">My complaints</h1>
        {canRaise?.allowed && (
          <Link to="/complaints/new" className={buttonClass("primary")}>
            <PlusIcon size={18} />
            New complaint
          </Link>
        )}
        {canRaise && !canRaise.allowed && (
          <button type="button" disabled aria-describedby="new-complaint-reason" className={buttonClass("primary")}>
            <PlusIcon size={18} />
            New complaint
          </button>
        )}
      </div>

      {canRaise && !canRaise.allowed && (
        <p id="new-complaint-reason" className="hc-pill-amber flex items-start gap-2.5 rounded-2xl px-3.5 py-3 text-sm font-medium">
          <WarningIcon size={18} className="mt-px shrink-0" />
          {canRaise.reason}
        </p>
      )}

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !result ? (
        <ListSkeleton label="Loading your complaints…" rows={3} />
      ) : result.total === 0 ? (
        <EmptyState
          title="You have not raised any complaints."
          description="If something in your room needs fixing, tell the hostel here."
          tone="violet"
          icon={<MessageIcon />}
        />
      ) : (
        <>
          <ul className="space-y-3">
            {result.items.map((c, i) => {
              const titleId = `complaint-${c.id}`;
              const { tone, Icon } = categoryLook[c.category];
              return (
                <li key={c.id} aria-labelledby={titleId} className="rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <Link
                    to={`/complaints/${c.id}`}
                    className="press flex items-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card hover:bg-soft"
                  >
                    <IconTile tone={tone} size="sm">
                      <Icon size={18} />
                    </IconTile>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <span id={titleId} className="font-semibold text-ink">
                          {categoryLabel[c.category]}
                        </span>
                        <StatusBadge status={c.status} />
                      </div>
                      <p className="line-clamp-2 text-sm break-words text-ink">{c.description}</p>
                      <p className="text-xs text-muted">Raised {formatTime(c.createdAt)}</p>
                    </div>
                    <span aria-hidden="true" className="self-center text-faint">
                      <ChevronRightIcon size={18} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pages={pages} onPage={goTo} />
        </>
      )}
    </div>
  );
}

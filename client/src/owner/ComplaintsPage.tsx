import { useEffect, useState } from "react";
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
  categoryLook,
  formatTime,
  PriorityBadge,
  priorityLabel,
  StatusBadge,
  statusLabel,
} from "../components/complaintText";
import { Alert, EmptyState, IconTile } from "../ui";
import { ChevronRightIcon, SearchIcon } from "../ui/icons";
import { DateField, FilterPanel, listClass, ListSkeleton, PageHeader, Pager, SelectField } from "../ui/ListParts";

// The owner's complaint list (design doc, sections 5 and 9): every student's complaints,
// active first, high priority first, oldest first, as the server orders them. Every filter
// lives in the page address (/complaints?status=open&page=2), so Back, refresh and a
// bookmark all show the same list, as on the Students page.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

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
  const activeFilters = OWNER_FILTERS.filter((key) => key !== "page" && query[key]).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Complaints" subtitle="Active first, high priority first, oldest first" />

      <FilterPanel active={activeFilters} className="grid-cols-2 sm:grid-cols-3">
        <SelectField label="Status" value={query.status} onChange={(v) => update({ status: v })}>
          <option value="">All statuses</option>
          {COMPLAINT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel[s]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Priority" value={query.priority} onChange={(v) => update({ priority: v })}>
          <option value="">All priorities</option>
          {COMPLAINT_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabel[p]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Category" value={query.category} onChange={(v) => update({ category: v })}>
          <option value="">All categories</option>
          {COMPLAINT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel[c]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Building" value={query.buildingId} onChange={(v) => update({ buildingId: v })}>
          <option value="">All buildings</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </SelectField>
        <DateField label="From" value={query.from} onChange={(v) => update({ from: v })} />
        <DateField label="To" value={query.to} onChange={(v) => update({ to: v })} />
      </FilterPanel>

      {filtered && (
        <button
          type="button"
          onClick={() => setParams({})}
          className="min-h-11 text-sm font-semibold text-accent hover:underline"
        >
          Clear filters
        </button>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {result === null ? (
        !error && <ListSkeleton label="Loading complaints…" />
      ) : result.total === 0 ? (
        filtered ? (
          <EmptyState title="No complaints match these filters." tone="blue" icon={<SearchIcon />} />
        ) : (
          <EmptyState title="No complaints yet." description="Complaints that students raise will show up here." />
        )
      ) : (
        <>
          <p className="text-sm font-semibold text-muted">
            {result.total} {result.total === 1 ? "complaint" : "complaints"}
          </p>
          <ul aria-label="Complaints" className={listClass}>
            {result.items.map((c) => {
              const { tone, Icon } = categoryLook[c.category];
              return (
                <li key={c.id} className="relative flex items-start gap-3 px-4 py-3.5 hover:bg-soft">
                  <IconTile tone={tone} size="sm">
                    <Icon size={18} />
                  </IconTile>
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      {/* The link covers the whole row, so a tap anywhere opens the complaint. */}
                      <Link
                        to={`/complaints/${c.id}`}
                        className="font-semibold text-ink after:absolute after:inset-0 after:content-[''] hover:underline"
                      >
                        {categoryLabel[c.category]} #{c.id}
                      </Link>
                      <p className="truncate text-sm text-ink">{firstLine(c.description)}</p>
                      <p className="text-sm text-muted">
                        {c.student.name} ·{" "}
                        {c.place
                          ? [c.place.buildingName, c.place.roomNumber && `Room ${c.place.roomNumber}`]
                              .filter(Boolean)
                              .join(" · ")
                          : "Moved out"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:w-56 sm:flex-col sm:items-end">
                      <div className="flex gap-1.5">
                        <StatusBadge status={c.status} />
                        <PriorityBadge priority={c.priority} />
                      </div>
                      <p className="text-xs text-muted">Raised {formatTime(c.createdAt)}</p>
                    </div>
                  </div>
                  <span aria-hidden="true" className="hidden self-center text-faint sm:block">
                    <ChevronRightIcon size={18} />
                  </span>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pages={pages} onPage={goToPage} />
        </>
      )}
    </div>
  );
}

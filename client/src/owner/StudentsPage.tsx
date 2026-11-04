import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { getStructure, type Building } from "../api/structure";
import { listStudents, type DirectoryQuery, type StudentListItem } from "../api/students";
import { categoryLabel, formatDate, placeText } from "./format";

// The owner's student directory (design doc, sections 5 and 9). Every filter lives in
// the page address (/students?buildingId=2&page=3), so Back, refresh and a bookmark all
// show the same list. Phone numbers are deliberately not searchable: the search is part
// of that address, and phone numbers never go in URLs.

const PAGE_SIZE = 20; // the server's default page size

const FILTERS = ["search", "buildingId", "floorId", "roomId", "category", "status", "page"] as const;

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const inputClass =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";
const primaryButton =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500";
const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export function StudentsPage() {
  const [params, setParams] = useSearchParams();
  const query: DirectoryQuery = Object.fromEntries(
    FILTERS.flatMap((key) => (params.get(key) ? [[key, params.get(key)!]] : [])),
  );
  const queryKey = JSON.stringify(query);

  const [buildings, setBuildings] = useState<Building[]>([]);
  const [result, setResult] = useState<{ items: StudentListItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The search box is typed into freely and only applied on Search.
  const [search, setSearch] = useState(query.search ?? "");
  // Back, Forward or a link can change the address's search: show that one.
  useEffect(() => setSearch(query.search ?? ""), [query.search]);

  useEffect(() => {
    getStructure()
      .then(setBuildings)
      .catch(() => setBuildings([]));
  }, []);

  useEffect(() => {
    let current = true;
    setError(null);
    listStudents(query)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setError(errorText(err)));
    // Ignore an answer that arrives after the owner has already changed the filters.
    return () => {
      current = false;
    };
    // queryKey stands for query: a new object every render, but the same text.
  }, [queryKey]);

  // Changes some filters and goes back to page 1. Empty values are removed from the
  // address. A new building forgets the floor and room, a new floor forgets the room.
  const update = (changes: DirectoryQuery) => {
    const next = { ...query, ...changes, page: undefined };
    if ("buildingId" in changes) Object.assign(next, { floorId: undefined, roomId: undefined });
    if ("floorId" in changes) next.roomId = undefined;
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>);
  };

  const goToPage = (page: number) =>
    setParams({ ...(query as Record<string, string>), page: String(page) });

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    update({ search: search.trim() || undefined });
  };

  const building = buildings.find((b) => String(b.id) === query.buildingId);
  const floors = building?.floors ?? [];
  const rooms = building
    ? [
        ...building.floors
          .filter((f) => !query.floorId || String(f.id) === query.floorId)
          .flatMap((f) => f.rooms),
        ...(query.floorId ? [] : building.rooms),
      ]
    : [];

  const page = Number(query.page ?? "1");
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const filtered = FILTERS.some((key) => key !== "page" && query[key]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Students</h1>

      <form role="search" onSubmit={submitSearch} className="flex gap-2">
        <label htmlFor="student-search" className="sr-only">
          Search
        </label>
        <input
          id="student-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, email or room"
          className={inputClass}
        />
        <button type="submit" className={primaryButton}>
          Search
        </button>
      </form>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Filter label="Building" value={query.buildingId} onChange={(v) => update({ buildingId: v })}>
          <option value="">All buildings</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Filter>
        {floors.length > 0 && (
          <Filter label="Floor" value={query.floorId} onChange={(v) => update({ floorId: v })}>
            <option value="">All floors</option>
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.number === 0 ? "Ground floor" : `Floor ${f.number}`}
              </option>
            ))}
          </Filter>
        )}
        {rooms.length > 0 && (
          <Filter label="Room" value={query.roomId} onChange={(v) => update({ roomId: v })}>
            <option value="">All rooms</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNumber}
              </option>
            ))}
          </Filter>
        )}
        <Filter label="Category" value={query.category} onChange={(v) => update({ category: v })}>
          <option value="">All categories</option>
          {Object.entries(categoryLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Filter>
        <Filter label="Show" value={query.status} onChange={(v) => update({ status: v })}>
          <option value="">Current students</option>
          <option value="former">Former students</option>
          <option value="all">Everyone</option>
        </Filter>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {result === null ? (
        !error && <p className="text-sm text-slate-500">Loading…</p>
      ) : result.total === 0 ? (
        filtered ? (
          <p className="text-sm text-slate-600">No students match these filters.</p>
        ) : (
          <p className="text-sm text-slate-600">
            No students yet.{" "}
            <Link to="/students/new" className="font-medium text-indigo-700 underline">
              Admit a student
            </Link>
          </p>
        )
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {result.total} {result.total === 1 ? "student" : "students"}
          </p>
          <ul
            aria-label="Students"
            className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            {result.items.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/students/${s.id}`}
                    className="font-medium text-slate-900 hover:text-indigo-700 hover:underline"
                  >
                    {s.name}
                  </Link>
                  <p className="truncate text-sm text-slate-500">{s.email}</p>
                </div>
                <p className="text-sm text-slate-700 sm:w-64">
                  {s.place ? placeText(s.place) : "Left the hostel"}
                </p>
                <p className="text-sm text-slate-500 sm:w-48">
                  {categoryLabel[s.category]} · joined {formatDate(s.joiningDate)}
                </p>
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
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={inputClass}
      >
        {children}
      </select>
    </div>
  );
}

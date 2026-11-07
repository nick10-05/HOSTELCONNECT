import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { getStructure, type Building } from "../api/structure";
import { listStudents, type DirectoryQuery, type StudentListItem } from "../api/students";
import { Alert, buttonClass, EmptyState } from "../ui";
import { ChevronRightIcon, PlusIcon, SearchIcon, UsersIcon } from "../ui/icons";
import { Avatar, FilterPanel, listClass, ListSkeleton, PageHeader, Pager, SelectField } from "../ui/ListParts";
import { categoryLabel, formatDate, placeText } from "./format";
import { inputClass } from "./styles";

// The owner's student directory (design doc, sections 5 and 9). Every filter lives in
// the page address (/students?buildingId=2&page=3), so Back, refresh and a bookmark all
// show the same list. Phone numbers are deliberately not searchable: the search is part
// of that address, and phone numbers never go in URLs.

const PAGE_SIZE = 20; // the server's default page size

const FILTERS = ["search", "buildingId", "floorId", "roomId", "category", "status", "page"] as const;

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";


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
  // How many of the folding filters are on (the search box is always shown).
  const activeFilters = FILTERS.filter((key) => key !== "page" && key !== "search" && query[key]).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Students"
        action={
          <Link to="/students/new" className={buttonClass("primary")}>
            <PlusIcon size={18} />
            Admit
          </Link>
        }
      />

      <form role="search" onSubmit={submitSearch} className="flex gap-2">
        <label htmlFor="student-search" className="sr-only">
          Search
        </label>
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-faint">
            <SearchIcon size={18} />
          </span>
          <input
            id="student-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, email or room"
            className={`${inputClass} pl-10`}
          />
        </div>
        <button type="submit" className={buttonClass("strong")}>
          Search
        </button>
      </form>

      <FilterPanel active={activeFilters} className="sm:grid-cols-3">
        <SelectField label="Building" value={query.buildingId} onChange={(v) => update({ buildingId: v })}>
          <option value="">All buildings</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </SelectField>
        {floors.length > 0 && (
          <SelectField label="Floor" value={query.floorId} onChange={(v) => update({ floorId: v })}>
            <option value="">All floors</option>
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.number === 0 ? "Ground floor" : `Floor ${f.number}`}
              </option>
            ))}
          </SelectField>
        )}
        {rooms.length > 0 && (
          <SelectField label="Room" value={query.roomId} onChange={(v) => update({ roomId: v })}>
            <option value="">All rooms</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNumber}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label="Category" value={query.category} onChange={(v) => update({ category: v })}>
          <option value="">All categories</option>
          {Object.entries(categoryLabel).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Show" value={query.status} onChange={(v) => update({ status: v })}>
          <option value="">Current students</option>
          <option value="former">Former students</option>
          <option value="all">Everyone</option>
        </SelectField>
      </FilterPanel>

      {error && <Alert tone="error">{error}</Alert>}

      {result === null ? (
        !error && <ListSkeleton label="Loading students…" />
      ) : result.total === 0 ? (
        filtered ? (
          <EmptyState title="No students match these filters." tone="blue" icon={<SearchIcon />} />
        ) : (
          <EmptyState
            title="No students yet."
            tone="violet"
            icon={<UsersIcon />}
            action={
              <Link to="/students/new" className={buttonClass("primary")}>
                Admit a student
              </Link>
            }
          />
        )
      ) : (
        <>
          <p className="text-sm font-semibold text-muted">
            {result.total} {result.total === 1 ? "student" : "students"}
          </p>
          <ul aria-label="Students" className={listClass}>
            {result.items.map((s) => (
              <li key={s.id} className="relative flex items-center gap-3 px-4 py-3 hover:bg-soft">
                <Avatar name={s.name} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    {/* The link covers the whole row, so a tap anywhere opens the profile. */}
                    <Link
                      to={`/students/${s.id}`}
                      className="font-semibold text-ink after:absolute after:inset-0 after:content-[''] hover:underline"
                    >
                      {s.name}
                    </Link>
                    <p className="truncate text-sm text-muted">{s.email}</p>
                  </div>
                  <p className="text-sm font-medium text-ink sm:w-64">
                    {s.place ? placeText(s.place) : "Left the hostel"}
                  </p>
                  <p className="text-xs text-muted sm:w-48 sm:text-sm">
                    {categoryLabel[s.category]} · joined {formatDate(s.joiningDate)}
                  </p>
                </div>
                <span aria-hidden="true" className="text-faint">
                  <ChevronRightIcon size={18} />
                </span>
              </li>
            ))}
          </ul>
          <Pager page={page} pages={pages} onPage={goToPage} />
        </>
      )}
    </div>
  );
}

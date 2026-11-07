import { useId, useState, type ReactNode } from "react";
import { fieldClass } from ".";
import { ChevronLeftIcon, ChevronRightIcon, FilterIcon } from "./icons";

// The parts every list page shares (students, complaints, fees, notices…): the big title,
// the filters, the Previous / Next pager, a person's initials and the loading placeholder.

// ── PageHeader ──────────────────────────────────────────────────────────────────────
// A big, bold title like Samsung's One UI, with an optional line under it and a button
// on the right.
export function PageHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-medium text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Pager ───────────────────────────────────────────────────────────────────────────
const pagerButton =
  "press inline-flex min-h-11 items-center gap-1 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink shadow-card hover:bg-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-2">
      <button type="button" className={pagerButton} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeftIcon size={18} />
        Previous
      </button>
      <span className="text-sm font-medium text-muted">
        Page {page} of {pages}
      </span>
      <button type="button" className={pagerButton} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
        <ChevronRightIcon size={18} />
      </button>
    </nav>
  );
}

// ── FilterPanel ─────────────────────────────────────────────────────────────────────
// On a phone the filters fold away behind a Filters button (with how many are on); from
// md up they are always shown. Folded, they are display:none, so they leave the
// keyboard order and screen readers too.
export function FilterPanel({ active, className = "", children }: { active: number; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="press inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink shadow-card md:hidden"
      >
        <FilterIcon size={18} />
        Filters
        {active > 0 && (
          <>
            <span aria-hidden="true" className="bg-active rounded-full px-2 py-0.5 text-xs">
              {active}
            </span>
            <span className="sr-only">, {active} on</span>
          </>
        )}
      </button>
      <div
        id={id}
        className={`${open ? "grid" : "hidden"} gap-3 rounded-card border border-line bg-surface p-3 shadow-card md:grid md:border-0 md:bg-transparent md:p-0 md:shadow-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

const labelClass = "mb-1 block text-xs font-semibold tracking-wide text-muted uppercase";

// A drop-down with its label. An empty choice means "no filter".
export function SelectField({
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
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={fieldClass}>
        {children}
      </select>
    </div>
  );
}

// A day, as 'YYYY-MM-DD' (the browser's date picker gives exactly that).
export function DateField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string | undefined) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input id={id} type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={fieldClass} />
    </div>
  );
}

// ── Segmented ───────────────────────────────────────────────────────────────────────
// The iPhone's segmented control: a few choices side by side, one picked. Underneath it
// is a group of radio buttons, so the arrow keys move between the choices.
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="flex gap-1 overflow-x-auto rounded-2xl border border-line bg-soft p-1">
        {options.map(([v, text]) => (
          <label key={v} className="flex-1">
            <input
              type="radio"
              name={name}
              value={v}
              checked={value === v}
              onChange={() => onChange(v)}
              className="peer sr-only"
            />
            <span className="flex min-h-10 cursor-pointer items-center justify-center rounded-xl px-3 text-sm font-semibold whitespace-nowrap text-muted transition-colors peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-card peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--hc-accent)]">
              {text}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ── Avatar ──────────────────────────────────────────────────────────────────────────
// A person's initials on a colour picked from their name, so it stays the same. The
// name is always written next to it, so the circle is hidden from screen readers.
const avatarTones = ["hc-tile-violet", "hc-tile-pink", "hc-tile-orange", "hc-tile-green", "hc-tile-blue", "hc-tile-amber"];

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const tone = avatarTones[hash % avatarTones.length];
  const box = { sm: "size-9 text-xs", md: "size-11 text-sm", lg: "size-16 text-xl ring-4 ring-white/25" }[size];
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${box} ${tone}`}>
      {initials(name)}
    </span>
  );
}

// ── ListSkeleton ────────────────────────────────────────────────────────────────────
// Shimmering rows in place of "Loading…"; screen readers still hear the words.
export function ListSkeleton({ label = "Loading…", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex items-center gap-3 border-b border-line p-4 last:border-0">
          <div className="skeleton size-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-2/5" />
            <div className="skeleton h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

// The "← Back" link at the top of a detail page.
export const backLinkClass =
  "press inline-flex min-h-11 w-fit items-center rounded-full border border-line bg-surface px-3.5 text-sm font-semibold text-ink shadow-card hover:bg-soft";

// The look of a list of rows: one rounded card, rows split by thin lines.
export const listClass = "divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card";

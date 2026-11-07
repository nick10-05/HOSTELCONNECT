import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertCircleIcon, CheckIcon, InfoIcon, WarningIcon } from "./icons";

// The shared building blocks of the redesign (light "Aurora" and dark "Midnight").
// Colours come from the tokens in index.css, so every part follows light and dark mode.

export type Tone = "violet" | "pink" | "orange" | "green" | "blue" | "red" | "amber";
export type PillTone = "red" | "amber" | "green" | "violet" | "blue" | "grey";

// ── Buttons ─────────────────────────────────────────────────────────────────────────
// primary: the gradient call to action. strong: solid black (off-white in dark mode).
// secondary: outlined. danger: for moving out and other things that are hard to undo.
export type ButtonVariant = "primary" | "strong" | "secondary" | "danger";

const buttonBase =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-active",
  strong: "bg-strong text-strong-ink",
  secondary: "border border-line bg-surface text-ink hover:bg-soft",
  danger: "hc-pill-red",
};

// Text boxes, date pickers and drop-downs.
export const fieldClass =
  "block w-full min-h-11 rounded-xl border border-line bg-surface px-3.5 py-2 text-base text-ink placeholder:text-faint focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 focus:outline-none aria-invalid:border-red-400";

// For a <Link> or <a> that should look like a button.
export const buttonClass = (variant: ButtonVariant = "primary") => `${buttonBase} ${buttonVariants[variant]}`;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant };

export function Button({ variant = "primary", type = "button", className = "", ...props }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant)} ${className}`} {...props} />;
}

// ── Card ────────────────────────────────────────────────────────────────────────────
// With a title it is a named region (its heading names it), as the dashboard cards were.
type CardProps = { title?: ReactNode; action?: ReactNode; className?: string; children: ReactNode };

export function Card({ title, action, className = "", children }: CardProps) {
  const id = useId();
  const box = `space-y-3 rounded-card border border-line bg-surface p-4 shadow-card ${className}`;
  if (!title) return <div className={box}>{children}</div>;
  return (
    <section aria-labelledby={id} className={box}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="text-base font-bold text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Pill ────────────────────────────────────────────────────────────────────────────
export function Pill({ tone = "grey", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap hc-pill-${tone}`}
    >
      {children}
    </span>
  );
}

// ── Alert ───────────────────────────────────────────────────────────────────────────
// Errors are read out straight away (role=alert); the rest politely (role=status).
type AlertTone = "error" | "warning" | "success" | "info";
const alertStyle: Record<AlertTone, { pill: PillTone; Icon: typeof InfoIcon }> = {
  error: { pill: "red", Icon: AlertCircleIcon },
  warning: { pill: "amber", Icon: WarningIcon },
  success: { pill: "green", Icon: CheckIcon },
  info: { pill: "blue", Icon: InfoIcon },
};

export function Alert({ tone = "error", children }: { tone?: AlertTone; children: ReactNode }) {
  const { pill, Icon } = alertStyle[tone];
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-2xl px-3.5 py-3 text-sm leading-snug hc-pill-${pill}`}
    >
      <Icon size={18} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────────────
// A shimmering placeholder in place of "Loading…". Screen readers still hear the words.
export function Skeleton({ label = "Loading…", lines = 3 }: { label?: string; lines?: number }) {
  const widths = ["w-1/2", "w-1/3", "w-4/5", "w-2/3", "w-3/5"];
  return (
    <div role="status" className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} aria-hidden="true" className={`skeleton ${i === 1 ? "h-7" : "h-3.5"} ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

// ── EmptyState ──────────────────────────────────────────────────────────────────────
type EmptyStateProps = { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode; tone?: Tone };

export function EmptyState({ title, description, action, icon, tone = "green" }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-line bg-surface px-4 py-8 text-center shadow-card">
      <IconTile tone={tone} size="lg">
        {icon ?? <CheckIcon />}
      </IconTile>
      <p className="mt-1 font-bold text-ink">{title}</p>
      {description && <p className="text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── IconTile ────────────────────────────────────────────────────────────────────────
const tileSize = { sm: "size-9 rounded-xl", md: "size-11 rounded-2xl", lg: "size-14 rounded-[1.25rem]" };

export function IconTile({ tone, size = "md", children }: { tone: Tone; size?: keyof typeof tileSize; children: ReactNode }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center ${tileSize[size]} hc-tile-${tone}`}>
      {children}
    </span>
  );
}

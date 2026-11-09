import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getDashboard, type Dashboard, type UsageCard } from "../api/dashboard";
import { Alert, IconTile, type Tone } from "../ui";
import {
  BedIcon,
  BoltIcon,
  CheckIcon,
  ChevronRightIcon,
  FoodIcon,
  MegaphoneIcon,
  MessageIcon,
  PlusIcon,
  ReturnIcon,
  RupeeIcon,
  UserPlusIcon,
  UsersIcon,
  WarningIcon,
} from "../ui/icons";
import { formatDate, formatRupees } from "./format";
import { countsText } from "./ReturnPollsPage";

// The owner's home page (design doc, section 9): the cards looked at first, all from one
// GET /api/dashboard. Day 5: students per building and rejoin requests; day 6: complaints;
// day 8: storage and bandwidth; day 9: the return poll and fees. The redesign puts three
// things above the cards, all worked out from the same answer: how full the beds are,
// what needs the owner now, and shortcuts to the everyday jobs.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

// "1 student", "4 students".
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "Saturday, 7 November", in India's time.
const todayText = () =>
  new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );

// The links inside the cards.
const cardLink = "inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent hover:underline";

export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getDashboard()
      .then((d) => current && setData(d))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-muted">{todayText()}</p>
        <h1 className="text-title font-display text-3xl font-extrabold tracking-tight md:text-4xl">Dashboard</h1>
      </div>

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          <OccupancyHero students={data.students} />
          <div className="grid gap-4 md:grid-cols-2">
            <NeedsAttention data={data} />
            <QuickActions />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <StudentsCard students={data.students} />
            <ReturnPollCard poll={data.returnPoll} />
            <ComplaintsCard complaints={data.complaints} />
            <RequestsCard requests={data.rejoinRequests} />
            <FeesCard fees={data.fees} />
            <UsageCardView usage={data.usage} />
          </div>
        </>
      )}
    </div>
  );
}

// Shaped like the page, so nothing jumps when the numbers arrive.
function DashboardSkeleton() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Loading the dashboard…</span>
      <div aria-hidden="true" className="skeleton h-40 rounded-[1.75rem]" />
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
            <div className="skeleton h-3.5 w-1/3" />
            <div className="skeleton h-7 w-1/2" />
            <div className="skeleton h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── How full the hostel is ──────────────────────────────────────────────────────────

// Over the buildings that have beds; null while none has.
function bedTotals(buildings: Dashboard["students"]["buildings"]) {
  let total = 0;
  let occupied = 0;
  let any = false;
  for (const b of buildings) {
    if (!b.beds) continue;
    any = true;
    total += b.beds.total;
    occupied += b.beds.occupied;
  }
  if (!any) return null;
  return { total, occupied, vacant: total - occupied, percent: total ? Math.round((occupied / total) * 100) : 0 };
}

const chip =
  "rounded-full border border-[var(--hc-chip-line)] bg-[var(--hc-chip)] px-3 py-1 text-xs font-semibold text-hero-ink";

function OccupancyHero({ students }: { students: Dashboard["students"] }) {
  const beds = bedTotals(students.buildings);
  return (
    <div
      data-testid="occupancy"
      className="rise bg-hero relative overflow-hidden rounded-[1.75rem] p-5 shadow-[var(--hc-hero-shadow)] md:p-7"
    >
      {/* Soft light in the corners, for the eye only. */}
      <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/15 blur-2xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 left-10 size-40 rounded-full bg-white/10 blur-2xl" />
      <div className="relative flex items-center gap-5 md:gap-7">
        {beds && <Ring percent={beds.percent} />}
        <div className="min-w-0 space-y-1.5">
          {beds ? (
            <>
              <p className="text-hero-ink">
                <span className="font-display text-4xl font-extrabold tracking-tight md:text-5xl">{beds.percent}%</span>{" "}
                <span className="font-semibold">of beds filled</span>
              </p>
              <p className="text-sm text-hero-muted">
                {beds.occupied} of {count(beds.total, "bed")} taken · {beds.vacant} free
              </p>
            </>
          ) : (
            <p className="font-display text-2xl font-extrabold text-hero-ink">Your hostel</p>
          )}
          <p className="flex flex-wrap gap-2 pt-1">
            <span className={chip}>
              {students.total} {students.total === 1 ? "current student" : "current students"}
            </span>
            {students.joiningLater > 0 && <span className={chip}>{students.joiningLater} joining later</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

// The ring fills up to the percentage when the page opens (not with reduced motion).
const R = 44;
const CIRCLE = 2 * Math.PI * R;

function Ring({ percent }: { percent: number }) {
  const offset = CIRCLE * (1 - Math.min(100, percent) / 100);
  return (
    <div aria-hidden="true" className="relative size-24 shrink-0 md:size-28">
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--hc-track)" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="var(--hc-ring)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={CIRCLE}
          strokeDashoffset={offset}
          style={{ "--ring-full": `${CIRCLE}` } as CSSProperties}
          className="animate-[ring-fill_1.2s_cubic-bezier(0.2,0.8,0.2,1)_0.2s_backwards]"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-hero-ink">
        <BedIcon size={28} />
      </span>
    </div>
  );
}

// ── What needs the owner now ────────────────────────────────────────────────────────

type Attention = { text: string; to?: string; tone: Tone; Icon: typeof WarningIcon };

function attentionItems({ complaints, fees, rejoinRequests, usage }: Dashboard): Attention[] {
  const items: Attention[] = [];
  if (complaints.highPriority > 0) {
    items.push({
      text: count(complaints.highPriority, "high-priority complaint"),
      to: "/complaints",
      tone: "red",
      Icon: WarningIcon,
    });
  }
  if (fees.overdue.count > 0) {
    items.push({
      text: `${count(fees.overdue.count, "overdue fee")} · ${formatRupees(fees.overdue.amount)}`,
      to: "/fees",
      tone: "amber",
      Icon: RupeeIcon,
    });
  }
  if (rejoinRequests.pending > 0) {
    items.push({
      text: `${count(rejoinRequests.pending, "rejoin request")} waiting`,
      to: "/rejoin-requests",
      tone: "blue",
      Icon: UserPlusIcon,
    });
  }
  // These two have no page of their own; the usage card below explains them.
  if (usage.photosConfigured && usage.level === "uploads_off") {
    items.push({ text: "Photo uploads are off", tone: "red", Icon: BoltIcon });
  }
  if (usage.photosConfigured && usage.failingDeletions > 0) {
    items.push({ text: `${count(usage.failingDeletions, "photo")} failing to delete`, tone: "red", Icon: BoltIcon });
  }
  return items;
}

const panel = "rise rounded-card border border-line bg-surface p-4 shadow-card md:p-5";

function NeedsAttention({ data }: { data: Dashboard }) {
  const items = attentionItems(data);
  return (
    <div className={panel} style={{ animationDelay: "80ms" }}>
      <h2 id="attention-heading" className="mb-2 text-lg font-extrabold text-ink">
        Needs attention
      </h2>
      {items.length === 0 ? (
        <div className="flex items-center gap-3 py-2">
          <IconTile tone="green" size="sm">
            <CheckIcon size={18} />
          </IconTile>
          <div>
            <p className="font-bold text-ink">All caught up</p>
            <p className="text-sm text-muted">No urgent complaints, overdue fees or waiting requests.</p>
          </div>
        </div>
      ) : (
        <ul aria-labelledby="attention-heading" className="divide-y divide-line">
          {items.map(({ text, to, tone, Icon }) => {
            const inner = (
              <>
                <IconTile tone={tone} size="sm">
                  <Icon size={18} />
                </IconTile>
                <span className="min-w-0 flex-1 font-semibold text-ink">{text}</span>
              </>
            );
            return (
              <li key={text}>
                {to ? (
                  <Link to={to} className="press -mx-2 flex min-h-12 items-center gap-3 rounded-xl px-2 py-2 hover:bg-soft">
                    {inner}
                    <span className="text-faint">
                      <ChevronRightIcon size={18} />
                    </span>
                  </Link>
                ) : (
                  <div className="flex min-h-12 items-center gap-3 py-2">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Shortcuts ───────────────────────────────────────────────────────────────────────

const actions: { to: string; label: string; tone: Tone; Icon: typeof PlusIcon }[] = [
  { to: "/students/new", label: "Admit a student", tone: "violet", Icon: PlusIcon },
  { to: "/fees", label: "Mark fees paid", tone: "green", Icon: RupeeIcon },
  { to: "/announcements", label: "Post a notice", tone: "pink", Icon: MegaphoneIcon },
  { to: "/food-counts", label: "Today's food count", tone: "orange", Icon: FoodIcon },
];

function QuickActions() {
  return (
    <div className={panel} style={{ animationDelay: "140ms" }}>
      <h2 id="actions-heading" className="mb-3 text-lg font-extrabold text-ink">
        Quick actions
      </h2>
      <ul aria-labelledby="actions-heading" className="grid grid-cols-4 gap-2">
        {actions.map(({ to, label, tone, Icon }) => (
          <li key={label}>
            <Link
              to={to}
              className="press flex h-full flex-col items-center gap-2 rounded-2xl p-1 text-center text-xs leading-tight font-semibold text-ink"
            >
              <IconTile tone={tone}>
                <Icon />
              </IconTile>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── The cards ───────────────────────────────────────────────────────────────────────

const cardLook: Record<string, { tone: Tone; Icon: typeof UsersIcon; delay: number }> = {
  "card-students": { tone: "violet", Icon: UsersIcon, delay: 200 },
  "card-return-poll": { tone: "orange", Icon: ReturnIcon, delay: 240 },
  "card-complaints": { tone: "amber", Icon: MessageIcon, delay: 280 },
  "card-requests": { tone: "blue", Icon: UserPlusIcon, delay: 320 },
  "card-fees": { tone: "green", Icon: RupeeIcon, delay: 360 },
  "card-usage": { tone: "pink", Icon: BoltIcon, delay: 400 },
};

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const { tone, Icon, delay } = cardLook[id];
  return (
    <section
      aria-labelledby={id}
      style={{ animationDelay: `${delay}ms` }}
      className="rise space-y-3 rounded-card border border-line bg-surface p-4 shadow-card md:p-5"
    >
      <div className="flex items-center gap-3">
        <IconTile tone={tone} size="sm">
          <Icon size={18} />
        </IconTile>
        <h2 id={id} className="text-base font-bold text-ink">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function StudentsCard({ students }: { students: Dashboard["students"] }) {
  if (students.buildings.length === 0) {
    return (
      <Card id="card-students" title="Students">
        <p className="text-sm text-muted">
          No buildings yet. Add one on{" "}
          <Link to="/structure" className="font-semibold text-accent underline">
            Buildings and rooms
          </Link>
          .
        </p>
      </Card>
    );
  }
  return (
    <Card id="card-students" title="Students">
      <p className="text-ink">
        <span className="font-display text-3xl font-extrabold tracking-tight">{students.total}</span>{" "}
        {students.total === 1 ? "current student" : "current students"}
        {students.joiningLater > 0 && (
          <span className="text-sm text-muted">, including {students.joiningLater} joining later</span>
        )}
      </p>
      <ul className="divide-y divide-line">
        {students.buildings.map((b) => (
          <li key={b.id} className="flex flex-col py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <span className="shrink-0 font-semibold text-ink">{b.name}</span>
            <span className="text-sm text-muted sm:text-right">
              {count(b.students, "student")}
              {b.joiningLater > 0 && ` (${b.joiningLater} joining later)`}
              {" · "}
              {b.beds ? `${b.beds.vacant} of ${count(b.beds.total, "bed")} vacant` : "No beds yet"}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Section 9: the open return poll's counts, the same as on its results page; or a way to
// start one.
function ReturnPollCard({ poll }: { poll: Dashboard["returnPoll"] }) {
  return (
    <Card id="card-return-poll" title="Return poll">
      {poll ? (
        <>
          <p className="font-semibold text-ink">{poll.title}</p>
          <p className="text-sm text-muted">{countsText(poll.counts)}</p>
          <Link to={`/return-polls/${poll.id}`} className={cardLink}>
            See who is back
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">No poll open.</p>
          <Link to="/return-polls" className={cardLink}>
            Start a return poll
          </Link>
        </>
      )}
    </Card>
  );
}

// Section 9: pending fees. The server's FEE_ROW_DAYS_AHEAD, for the wording only.
const FEE_DAYS_AHEAD = 7;

function FeesCard({ fees }: { fees: Dashboard["fees"] }) {
  const lines = [
    { label: `Due in the next ${FEE_DAYS_AHEAD} days`, total: fees.dueSoon },
    { label: "Overdue", total: fees.overdue },
    { label: "Pending this month", total: fees.pendingThisMonth },
  ];
  const nothing = lines.every((l) => l.total.count === 0);
  return (
    <Card id="card-fees" title="Fees">
      {nothing ? (
        <p className="text-sm text-muted">No fees pending.</p>
      ) : (
        <dl className="space-y-2 text-sm">
          {lines.map(({ label, total }) => (
            <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-muted">{label}</dt>
              <dd className={label === "Overdue" && total.count > 0 ? "font-semibold text-danger" : "font-semibold text-ink"}>
                {count(total.count, "fee")} · {formatRupees(total.amount)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Link to="/fees" className={cardLink}>
        Open fees
      </Link>
    </Card>
  );
}

// How long ago, roughly: "under an hour", "5 hours", "3 days".
export function ageText(iso: string, now = Date.now()): string {
  const hours = Math.floor((now - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 24) return count(hours, "hour");
  return count(Math.floor(hours / 24), "day");
}

// Section 9: active complaints, how many are high priority, and how long the oldest has
// waited; opens the owner's list (day 7), which starts with the active ones.
function ComplaintsCard({ complaints }: { complaints: Dashboard["complaints"] }) {
  return (
    <Card id="card-complaints" title="Complaints">
      {complaints.active === 0 ? (
        <p className="text-sm text-muted">None open.</p>
      ) : (
        <p className="text-ink">
          <span className="font-display text-3xl font-extrabold tracking-tight">{complaints.active}</span> active
          <span className="text-sm text-muted">
            {complaints.highPriority > 0 && `, ${complaints.highPriority} high priority`}
            {complaints.oldestActiveAt &&
              `, ${complaints.active === 1 ? "waiting" : "the oldest waiting"} ${ageText(complaints.oldestActiveAt)}`}
          </span>
        </p>
      )}
      <Link to="/complaints" className={cardLink}>
        Open complaints
      </Link>
    </Card>
  );
}

// The usage guard's thresholds (server/src/services/usage.ts), for the card's wording only:
// the server decides the level.
const AMBER_PERCENT = 70;
const UPLOADS_OFF_PERCENT = 85;
const DELETE_WARNING_ATTEMPTS = 5;

const MB = 1024 * 1024;
// 12936274 → "12.3 MB", 3145728000 → "3,000 MB".
const mbText = (bytes: number) => `${(bytes / MB).toLocaleString("en-IN", { maximumFractionDigits: 1 })} MB`;
// '2026-11' → "November 2026"; and the first day of the month after: "1 December 2026".
const monthText = (month: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
function nextMonthStart(month: string): string {
  const [year, m] = month.split("-").map(Number);
  // Months count from 0 in Date.UTC, so `m` (1 to 12) is already the month after.
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, m, 1)),
  );
}

// Section 10: how much of Supabase's free storage and monthly bandwidth the photos use.
// Amber from AMBER_PERCENT of any limit; photo uploads switch off at
// UPLOADS_OFF_PERCENT; a warning when photos keep failing to delete. The owner sees their
// own photos against their hostel's share of storage (phase 5b); all hostels' photos
// together only once those near the whole limit, since that can switch uploads off too.
function UsageCardView({ usage }: { usage: UsageCard }) {
  if (!usage.photosConfigured) {
    return (
      <Card id="card-usage" title="Storage and bandwidth">
        <p className="text-sm text-muted">Photo storage is not set up, so complaints are text only.</p>
      </Card>
    );
  }
  const reasons = [];
  if (usage.egress.percent >= UPLOADS_OFF_PERCENT) {
    reasons.push(`The bandwidth count starts again on ${nextMonthStart(usage.egress.month)}.`);
  }
  if (Math.max(usage.storage.percent, usage.hostelStorage.percent) >= UPLOADS_OFF_PERCENT) {
    reasons.push("Space frees up as photos are deleted 48 hours after upload.");
  }
  return (
    <Card id="card-usage" title="Storage and bandwidth">
      <dl className="space-y-3">
        <UsageLine label="Photos stored" used={usage.hostelStorage} />
        {usage.storage.percent >= AMBER_PERCENT && <UsageLine label="Photos of all hostels" used={usage.storage} />}
        <UsageLine label={`Bandwidth in ${monthText(usage.egress.month)}`} used={usage.egress} />
      </dl>
      {usage.level === "uploads_off" ? (
        <p role="alert" className="hc-pill-red rounded-xl px-3 py-2 text-sm">
          Photo uploads are off: usage has reached {UPLOADS_OFF_PERCENT}% of a free limit. Students can still send
          complaints as text. {reasons.join(" ")}
        </p>
      ) : usage.level === "amber" ? (
        <p role="status" className="hc-pill-amber rounded-xl px-3 py-2 text-sm">
          Over {AMBER_PERCENT}% of a free limit. Photo uploads switch off at {UPLOADS_OFF_PERCENT}%.
        </p>
      ) : (
        <p className="text-sm text-muted">Photo uploads are on.</p>
      )}
      {usage.failingDeletions > 0 && (
        <p role="alert" className="hc-pill-red rounded-xl px-3 py-2 text-sm">
          {count(usage.failingDeletions, "photo")} could not be deleted after {DELETE_WARNING_ATTEMPTS} tries. The
          hourly job keeps trying; check Supabase Storage.
        </p>
      )}
    </Card>
  );
}

function UsageLine({ label, used }: { label: string; used: { usedBytes: number; limitBytes: number; percent: number } }) {
  const bar =
    used.percent >= UPLOADS_OFF_PERCENT ? "bg-rose-500" : used.percent >= AMBER_PERCENT ? "bg-amber-500" : "bg-active";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <dt className="text-muted">{label}</dt>
        <dd className="text-ink">
          {mbText(used.usedBytes)} of {mbText(used.limitBytes)} ({used.percent}%)
        </dd>
      </div>
      {/* The numbers above say it all; the bar is for the eye. */}
      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-soft">
        <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, used.percent)}%` }} />
      </div>
    </div>
  );
}

function RequestsCard({ requests }: { requests: Dashboard["rejoinRequests"] }) {
  return (
    <Card id="card-requests" title="Rejoin requests">
      {requests.pending === 0 ? (
        <p className="text-sm text-muted">None waiting.</p>
      ) : (
        <>
          <p className="text-ink">
            <span className="font-display text-3xl font-extrabold tracking-tight">{requests.pending}</span> waiting
            {requests.oldestRequestedOn && (
              <span className="text-sm text-muted">
                , {requests.pending === 1 ? "since" : "the oldest since"} {formatDate(requests.oldestRequestedOn)}
              </span>
            )}
          </p>
          <Link to="/rejoin-requests" className={cardLink}>
            Review requests
          </Link>
        </>
      )}
    </Card>
  );
}

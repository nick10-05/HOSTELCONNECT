import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getDashboard, type Dashboard, type UsageCard } from "../api/dashboard";
import { formatDate } from "./format";

// The owner's home page (design doc, section 9): the cards looked at first, all from one
// GET /api/dashboard. Day 5: students per building and rejoin requests; day 6: complaints;
// day 8: storage and bandwidth; later days add their cards here.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

// "1 student", "4 students".
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
      <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <StudentsCard students={data.students} />
          <ComplaintsCard complaints={data.complaints} />
          <RequestsCard requests={data.rejoinRequests} />
          <UsageCardView usage={data.usage} />
        </div>
      )}
    </div>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 id={id} className="text-sm font-semibold text-slate-700">
        {title}
      </h2>
      {children}
    </section>
  );
}

function StudentsCard({ students }: { students: Dashboard["students"] }) {
  if (students.buildings.length === 0) {
    return (
      <Card id="card-students" title="Students">
        <p className="text-sm text-slate-700">
          No buildings yet. Add one on{" "}
          <Link to="/structure" className="font-medium text-indigo-700 underline">
            Buildings and rooms
          </Link>
          .
        </p>
      </Card>
    );
  }
  return (
    <Card id="card-students" title="Students">
      <p className="text-slate-900">
        <span className="text-2xl font-semibold">{students.total}</span>{" "}
        {students.total === 1 ? "current student" : "current students"}
        {students.joiningLater > 0 && (
          <span className="text-sm text-slate-500">, including {students.joiningLater} joining later</span>
        )}
      </p>
      <ul className="divide-y divide-slate-100">
        {students.buildings.map((b) => (
          <li key={b.id} className="flex flex-col py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <span className="font-medium text-slate-900">{b.name}</span>
            <span className="text-sm text-slate-600">
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
        <p className="text-sm text-slate-600">None open.</p>
      ) : (
        <p className="text-slate-900">
          <span className="text-2xl font-semibold">{complaints.active}</span> active
          <span className="text-sm text-slate-500">
            {complaints.highPriority > 0 && `, ${complaints.highPriority} high priority`}
            {complaints.oldestActiveAt &&
              `, ${complaints.active === 1 ? "waiting" : "the oldest waiting"} ${ageText(complaints.oldestActiveAt)}`}
          </span>
        </p>
      )}
      <Link to="/complaints" className="inline-block text-sm font-medium text-indigo-700 hover:underline">
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
// Amber from AMBER_PERCENT of either limit; photo uploads switch off at
// UPLOADS_OFF_PERCENT; a warning when photos keep failing to delete.
function UsageCardView({ usage }: { usage: UsageCard }) {
  if (!usage.photosConfigured) {
    return (
      <Card id="card-usage" title="Storage and bandwidth">
        <p className="text-sm text-slate-600">Photo storage is not set up, so complaints are text only.</p>
      </Card>
    );
  }
  const reasons = [];
  if (usage.egress.percent >= UPLOADS_OFF_PERCENT) {
    reasons.push(`The bandwidth count starts again on ${nextMonthStart(usage.egress.month)}.`);
  }
  if (usage.storage.percent >= UPLOADS_OFF_PERCENT) {
    reasons.push("Space frees up as photos are deleted 48 hours after upload.");
  }
  return (
    <Card id="card-usage" title="Storage and bandwidth">
      <dl className="space-y-3">
        <UsageLine label="Photos stored" used={usage.storage} />
        <UsageLine label={`Bandwidth in ${monthText(usage.egress.month)}`} used={usage.egress} />
      </dl>
      {usage.level === "uploads_off" ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Photo uploads are off: usage has reached {UPLOADS_OFF_PERCENT}% of a free limit. Students can still send
          complaints as text. {reasons.join(" ")}
        </p>
      ) : usage.level === "amber" ? (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Over {AMBER_PERCENT}% of a free limit. Photo uploads switch off at {UPLOADS_OFF_PERCENT}%.
        </p>
      ) : (
        <p className="text-sm text-slate-600">Photo uploads are on.</p>
      )}
      {usage.failingDeletions > 0 && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {count(usage.failingDeletions, "photo")} could not be deleted after {DELETE_WARNING_ATTEMPTS} tries. The
          hourly job keeps trying; check Supabase Storage.
        </p>
      )}
    </Card>
  );
}

function UsageLine({ label, used }: { label: string; used: { usedBytes: number; limitBytes: number; percent: number } }) {
  const bar =
    used.percent >= UPLOADS_OFF_PERCENT ? "bg-red-500" : used.percent >= AMBER_PERCENT ? "bg-amber-500" : "bg-indigo-500";
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <dt className="text-slate-700">{label}</dt>
        <dd className="text-slate-900">
          {mbText(used.usedBytes)} of {mbText(used.limitBytes)} ({used.percent}%)
        </dd>
      </div>
      {/* The numbers above say it all; the bar is for the eye. */}
      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, used.percent)}%` }} />
      </div>
    </div>
  );
}

function RequestsCard({ requests }: { requests: Dashboard["rejoinRequests"] }) {
  return (
    <Card id="card-requests" title="Rejoin requests">
      {requests.pending === 0 ? (
        <p className="text-sm text-slate-600">None waiting.</p>
      ) : (
        <>
          <p className="text-slate-900">
            <span className="text-2xl font-semibold">{requests.pending}</span> waiting
            {requests.oldestRequestedOn && (
              <span className="text-sm text-slate-500">
                , {requests.pending === 1 ? "since" : "the oldest since"} {formatDate(requests.oldestRequestedOn)}
              </span>
            )}
          </p>
          <Link to="/rejoin-requests" className="inline-block text-sm font-medium text-indigo-700 hover:underline">
            Review requests
          </Link>
        </>
      )}
    </Card>
  );
}

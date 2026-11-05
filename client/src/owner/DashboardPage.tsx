import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getDashboard, type Dashboard } from "../api/dashboard";
import { formatDate } from "./format";

// The owner's home page (design doc, section 9): the cards looked at first, all from one
// GET /api/dashboard. Day 5: students per building and rejoin requests; day 6: complaints;
// later days add their cards here.

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

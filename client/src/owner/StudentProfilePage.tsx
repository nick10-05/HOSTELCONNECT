import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { getStudent, type StudentProfile } from "../api/students";
import { categoryLabel, foodText, formatDate, formatMobile, formatRupees, placeText } from "./format";

// One student's profile for the owner (design doc, section 5). Read-only for now:
// transfer, deactivate and password reset arrive on day 5; fee history on day 9.
// Phone numbers appear only here, never in the directory or the page address.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function StudentProfilePage() {
  const { id } = useParams();
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setStudent(null);
    setError(null);
    getStudent(Number(id))
      .then((s) => current && setStudent(s))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [id]);

  const back = (
    <Link to="/students" className="text-sm font-medium text-indigo-700 hover:underline">
      ← All students
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      </div>
    );
  }
  if (!student) return <p className="text-sm text-slate-500">Loading…</p>;

  const s = student;
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-slate-900">{s.name}</h1>
        {!s.isActive && <Badge tone="slate">Former student</Badge>}
        {s.isActive && s.mustChangePassword && <Badge tone="amber">Has not logged in yet</Badge>}
      </div>

      <Card title="Contact">
        <Item label="Email">{s.email}</Item>
        <Item label="Mobile">{formatMobile(s.phone)}</Item>
        <Item label="Parent or guardian">{formatMobile(s.parentPhone)}</Item>
      </Card>

      <Card title={categoryLabel[s.category]}>
        {s.category === "college" && (
          <>
            <Item label="College">{s.collegeName}</Item>
            <Item label="Branch">{s.branch}</Item>
            <Item label="Year">{s.academicYear}</Item>
          </>
        )}
        {s.category === "working" && (
          <>
            <Item label="Company">{s.company}</Item>
            <Item label="Designation">{s.designation ?? "—"}</Item>
          </>
        )}
        {s.category === "other" && <Item label="Category">Other</Item>}
      </Card>

      <Card title="Stay and fees">
        <Item label="Lives in">
          {s.currentStay
            ? placeText(s.currentStay, { withFloor: true })
            : s.deactivatedAt
              ? `Left on ${formatDate(s.deactivatedAt)}`
              : "No current stay"}
        </Item>
        <Item label="Joined">{formatDate(s.joiningDate)}</Item>
        <Item label="Food">{foodText(s.foodPreference, s.vegDays)}</Item>
        <Item label="Monthly fee">{s.monthlyFee === null ? "Not set" : formatRupees(s.monthlyFee)}</Item>
        {s.nextDueDate && <Item label="Next due date">{formatDate(s.nextDueDate)}</Item>}
      </Card>

      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="stay-history" className="text-sm font-semibold text-slate-700">
          Stay history
        </h2>
        <ul aria-labelledby="stay-history" className="divide-y divide-slate-100">
          {s.stays.map((stay) => (
            <li key={stay.id} className="flex flex-col py-2 sm:flex-row sm:justify-between sm:gap-4">
              <span className="text-slate-900">{placeText(stay, { withFloor: true })}</span>
              <span className="text-sm text-slate-500">
                {formatDate(stay.startedOn)} – {stay.endedOn ? formatDate(stay.endedOn) : "now"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-slate-900">{children}</dd>
    </div>
  );
}

function Badge({ tone, children }: { tone: "slate" | "amber"; children: ReactNode }) {
  const colours = tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colours}`}>{children}</span>;
}

import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ApiError } from "../api/client";
import { getComplaint, type ComplaintDetail } from "../api/complaints";
import { ComplaintTimeline } from "../components/ComplaintTimeline";
import { categoryLabel, formatTime, StatusBadge } from "../components/complaintText";

// One of the student's complaints with its timeline (design doc, sections 4 and 9).
// Students only read: no replies, updates or reopening. A complaint that does not exist
// and someone else's get the same answer from the server, shown as it comes.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function ComplaintDetailPage() {
  const { id } = useParams();
  // Set by the form after sending, so the page can confirm it.
  const created = (useLocation().state as { created?: boolean } | null)?.created === true;

  const [complaint, setComplaint] = useState<ComplaintDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setComplaint(null);
    setError(null);
    getComplaint(id!)
      .then((c) => current && setComplaint(c))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [id]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Link to="/" className="text-sm font-medium text-indigo-700 hover:underline">
        ← My complaints
      </Link>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !complaint ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          {created && (
            <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Your complaint has been sent. The owner will see it on the dashboard.
            </p>
          )}

          <section aria-labelledby="complaint-heading" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="flex items-start justify-between gap-2">
              <h1 id="complaint-heading" className="text-xl font-semibold text-slate-900">
                {categoryLabel[complaint.category]}
              </h1>
              <StatusBadge status={complaint.status} />
            </div>
            <p className="whitespace-pre-line break-words text-slate-800">{complaint.description}</p>
            <p className="text-sm text-slate-500">
              Raised {formatTime(complaint.createdAt)}
              {complaint.resolvedAt && ` · resolved ${formatTime(complaint.resolvedAt)}`}
            </p>
          </section>

          <ComplaintTimeline events={complaint.events} viewer="student" />
        </>
      )}
    </div>
  );
}

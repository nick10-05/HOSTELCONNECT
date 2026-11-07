import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ApiError } from "../api/client";
import { getComplaint, type StudentComplaintDetail } from "../api/complaints";
import { ComplaintPhoto } from "../components/ComplaintPhoto";
import { ComplaintTimeline } from "../components/ComplaintTimeline";
import { categoryLabel, categoryLook, formatTime, StatusBadge } from "../components/complaintText";
import type { ComplaintCategory } from "../api/complaints";
import { IconTile, Skeleton } from "../ui";
import { backLinkClass } from "../ui/ListParts";

// One of the student's complaints with its timeline (design doc, sections 4 and 9).
// Students only read: no replies, updates or reopening. A complaint that does not exist
// and someone else's get the same answer from the server, shown as it comes. The photo
// (day 8) shows until it expires, without a countdown.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function ComplaintDetailPage() {
  const { id } = useParams();
  // Set by the form after sending, so the page can confirm it.
  const created = (useLocation().state as { created?: boolean } | null)?.created === true;

  const [complaint, setComplaint] = useState<StudentComplaintDetail | null>(null);
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
      <Link to="/" className={backLinkClass}>
        ← My complaints
      </Link>

      {error ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      ) : !complaint ? (
        <Skeleton label="Loading the complaint…" lines={5} />
      ) : (
        <>
          {created && (
            <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
              Your complaint has been sent. The owner will see it on the dashboard.
            </p>
          )}

          <section aria-labelledby="complaint-heading" className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <CategoryTile category={complaint.category} />
                <h1 id="complaint-heading" className="font-display text-2xl font-extrabold tracking-tight text-ink md:text-3xl">
                  {categoryLabel[complaint.category]}
                </h1>
              </div>
              <StatusBadge status={complaint.status} />
            </div>
            <p className="whitespace-pre-line break-words text-ink">{complaint.description}</p>
            <p className="text-sm text-muted">
              Raised {formatTime(complaint.createdAt)}
              {complaint.resolvedAt && ` · resolved ${formatTime(complaint.resolvedAt)}`}
            </p>
            <ComplaintPhoto photo={complaint.photo} />
          </section>

          <ComplaintTimeline events={complaint.events} viewer="student" />
        </>
      )}
    </div>
  );
}

function CategoryTile({ category }: { category: ComplaintCategory }) {
  const { tone, Icon } = categoryLook[category];
  return (
    <IconTile tone={tone}>
      <Icon />
    </IconTile>
  );
}

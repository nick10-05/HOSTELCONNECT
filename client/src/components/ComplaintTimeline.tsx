import type { ComplaintEvent } from "../api/complaints";
import { formatTime, statusLabel } from "./complaintText";

// A complaint's timeline, oldest entry first (design doc, sections 4 and 9), shared by the
// student's and the owner's complaint pages. Only the wording differs: the student reads
// about "you" and "the owner", the owner about "the student" and the moves he made.

export type TimelineViewer = "student" | "owner";

function eventText(e: ComplaintEvent, viewer: TimelineViewer): string {
  if (e.kind === "created") return viewer === "student" ? "You raised this complaint" : "Raised by the student";
  if (e.kind === "status_change" && e.toStatus) {
    if (viewer === "owner" && e.fromStatus) {
      return `Moved from ${statusLabel[e.fromStatus]} to ${statusLabel[e.toStatus]}`;
    }
    return `Status changed to ${statusLabel[e.toStatus]}`;
  }
  return viewer === "student" ? "Note from the owner" : "Note";
}

export function ComplaintTimeline({ events, viewer }: { events: ComplaintEvent[]; viewer: TimelineViewer }) {
  return (
    <section aria-labelledby="timeline-heading" className="space-y-4 rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 id="timeline-heading" className="text-base font-bold text-ink">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <ol className="relative space-y-5 pl-6 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-0.5 before:rounded-full before:bg-line">
          {events.map((e, i) => (
            <li key={i} className="relative space-y-1">
              {/* A dot on the line; the newest is coloured. */}
              <span
                aria-hidden="true"
                className={`absolute top-1 -left-6 size-3 rounded-full ring-4 ring-[var(--hc-surface)] ${i === events.length - 1 ? "bg-active" : "bg-faint"}`}
              />
              <p className="text-sm font-semibold text-ink">{eventText(e, viewer)}</p>
              {e.note && <p className="rounded-xl bg-soft px-3 py-2 text-sm whitespace-pre-line break-words text-ink">{e.note}</p>}
              <p className="text-xs text-muted">{formatTime(e.createdAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

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
    <section aria-labelledby="timeline-heading" className="space-y-3">
      <h2 id="timeline-heading" className="text-sm font-semibold text-slate-700">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing yet.</p>
      ) : (
        <ol className="space-y-3 border-l-2 border-slate-200 pl-4">
          {events.map((e, i) => (
            <li key={i} className="space-y-1">
              <p className="text-sm font-medium text-slate-800">{eventText(e, viewer)}</p>
              {e.note && <p className="whitespace-pre-line break-words text-sm text-slate-700">{e.note}</p>}
              <p className="text-xs text-slate-500">{formatTime(e.createdAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

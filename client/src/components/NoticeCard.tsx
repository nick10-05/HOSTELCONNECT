import type { ReactNode } from "react";
import type { Announcement } from "../api/announcements";
import { formatTime } from "./complaintText";

// One notice, as the owner and the students see it (design doc, section 9: urgent and
// pinned notices stand out). The owner's page puts its buttons in `children`.
export function NoticeCard({ notice, children }: { notice: Announcement; children?: ReactNode }) {
  const titleId = `notice-${notice.id}`;
  const edited = notice.updatedAt !== notice.createdAt;
  return (
    <article
      aria-labelledby={titleId}
      className={`rise relative space-y-2 overflow-hidden rounded-card border bg-surface p-4 shadow-card md:p-5 ${
        notice.isUrgent ? "border-rose-400/50 ring-1 ring-rose-400/30" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} className="text-base font-bold break-words text-ink">
          {notice.title}
        </h2>
        <div className="flex gap-2">
          {notice.isUrgent && (
            <span className="hc-pill-red rounded-full px-2.5 py-0.5 text-xs font-bold">Urgent</span>
          )}
          {notice.isPinned && (
            <span className="hc-pill-violet rounded-full px-2.5 py-0.5 text-xs font-bold">Pinned</span>
          )}
        </div>
      </div>
      <p className="whitespace-pre-line break-words text-sm text-ink">{notice.body}</p>
      <p className="text-xs text-muted">
        Posted {formatTime(notice.createdAt)}
        {edited && ` · edited ${formatTime(notice.updatedAt)}`}
      </p>
      {children}
    </article>
  );
}

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
      className={`space-y-2 rounded-xl border bg-white p-4 shadow-sm ${
        notice.isUrgent ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} className="font-semibold break-words text-slate-900">
          {notice.title}
        </h2>
        <div className="flex gap-2">
          {notice.isUrgent && (
            <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">Urgent</span>
          )}
          {notice.isPinned && (
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">Pinned</span>
          )}
        </div>
      </div>
      <p className="whitespace-pre-line break-words text-sm text-slate-800">{notice.body}</p>
      <p className="text-xs text-slate-500">
        Posted {formatTime(notice.createdAt)}
        {edited && ` · edited ${formatTime(notice.updatedAt)}`}
      </p>
      {children}
    </article>
  );
}

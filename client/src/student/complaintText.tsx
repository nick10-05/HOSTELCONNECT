import type { ComplaintCategory, ComplaintStatus } from "../api/complaints";

// Display helpers shared by the student's complaint screens.

export const categoryLabel: Record<ComplaintCategory, string> = {
  plumbing: "Plumbing",
  electrical: "Electrical",
  cleanliness: "Cleanliness",
  internet: "Internet",
  food: "Food",
  furniture: "Furniture",
  security: "Security",
  other: "Other",
};

export const statusLabel: Record<ComplaintStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  rejected: "Rejected",
};

const statusColour: Record<ComplaintStatus, string> = {
  open: "bg-amber-50 text-amber-800",
  in_progress: "bg-indigo-50 text-indigo-700",
  resolved: "bg-emerald-50 text-emerald-800",
  rejected: "bg-slate-100 text-slate-700",
};

export function StatusBadge({ status }: { status: ComplaintStatus }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColour[status]}`}>
      {statusLabel[status]}
    </span>
  );
}

// '5 Nov 2026, 10:00 am', in India's time, whatever the device's zone.
const timeFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));

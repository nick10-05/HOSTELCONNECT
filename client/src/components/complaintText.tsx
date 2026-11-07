import type { ComplaintCategory, ComplaintPriority, ComplaintStatus } from "../api/complaints";
import type { Tone } from "../ui";
import { BedIcon, BoltIcon, DropIcon, FoodIcon, HomeIcon, MessageIcon, WarningIcon, WifiIcon } from "../ui/icons";

// Display helpers shared by the student's and the owner's complaint screens.

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

// Each kind of complaint gets its own icon and colour, so a list is quick to scan.
export const categoryLook: Record<ComplaintCategory, { tone: Tone; Icon: typeof DropIcon }> = {
  plumbing: { tone: "blue", Icon: DropIcon },
  electrical: { tone: "amber", Icon: BoltIcon },
  cleanliness: { tone: "green", Icon: HomeIcon },
  internet: { tone: "violet", Icon: WifiIcon },
  food: { tone: "orange", Icon: FoodIcon },
  furniture: { tone: "pink", Icon: BedIcon },
  security: { tone: "red", Icon: WarningIcon },
  other: { tone: "violet", Icon: MessageIcon },
};

export const statusLabel: Record<ComplaintStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  rejected: "Rejected",
};

const statusColour: Record<ComplaintStatus, string> = {
  open: "hc-pill-amber",
  in_progress: "hc-pill-violet",
  resolved: "hc-pill-green",
  rejected: "hc-pill-grey",
};

export function StatusBadge({ status }: { status: ComplaintStatus }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${statusColour[status]}`}>
      {statusLabel[status]}
    </span>
  );
}

// The owner's only (section 4: students never see the priority).
export const priorityLabel: Record<ComplaintPriority, string> = {
  high: "High priority",
  normal: "Normal priority",
  low: "Low priority",
};

const priorityColour: Record<ComplaintPriority, string> = {
  high: "hc-pill-red",
  normal: "hc-pill-grey",
  low: "hc-pill-grey opacity-80",
};

export function PriorityBadge({ priority }: { priority: ComplaintPriority }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap ${priorityColour[priority]}`}>
      {priorityLabel[priority]}
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

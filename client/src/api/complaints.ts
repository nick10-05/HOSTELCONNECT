import { apiFetch } from "./client";

// Complaints: a student's own (day 6) and the owner's view of all of them (day 7). Shapes
// match server/src/routes/complaints.ts and services/complaints.ts. Text only until day 8.

// The server's categories, in the order the form shows them.
export const COMPLAINT_CATEGORIES = [
  "plumbing",
  "electrical",
  "cleanliness",
  "internet",
  "food",
  "furniture",
  "security",
  "other",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_STATUSES = ["open", "in_progress", "resolved", "rejected"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_PRIORITIES = ["high", "normal", "low"] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

// Times are ISO timestamps. A student never sees the priority.
export type ComplaintItem = {
  id: number;
  category: ComplaintCategory;
  description: string;
  status: ComplaintStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type ComplaintEvent = {
  kind: "created" | "status_change" | "note";
  note: string | null;
  fromStatus: ComplaintStatus | null;
  toStatus: ComplaintStatus | null;
  createdAt: string;
};

export type ComplaintDetail = ComplaintItem & { events: ComplaintEvent[] };

// Whether a new complaint is possible now. `reason` is the server's own refusal message
// when the active or the 24-hour limit is reached; `activeCategories` already have an
// active complaint, so the form offers them as unavailable.
export type RaiseStatus = {
  allowed: boolean;
  reason: string | null;
  activeCategories: ComplaintCategory[];
};

export type ComplaintList = { items: ComplaintItem[]; total: number; canRaise: RaiseStatus };

export type NewComplaint = { category: ComplaintCategory; description: string };

// The description's rules, the same as the server's: trimmed, then 10 to 500 characters
// counted as the database counts them (an emoji is one character, not two).
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 500;
export const descriptionLength = (text: string) => [...text.trim()].length;

// GET /api/complaints: your own complaints, newest first, 20 a page, and whether you can
// raise a new one.
export async function listMyComplaints(page = 1): Promise<ComplaintList> {
  return apiFetch<ComplaintList>(`/api/complaints?page=${page}`);
}

// POST /api/complaints. Refusals arrive as ApiError with the server's message, shown
// as-is: 400 "invalid_input"; 429 "category_active", "too_many_active",
// "too_many_recent" or "rate_limited".
export async function createComplaint(complaint: NewComplaint): Promise<ComplaintDetail> {
  return apiFetch<ComplaintDetail>("/api/complaints", { method: "POST", body: complaint });
}

// GET /api/complaints/:id. 404 "complaint_not_found" if it does not exist or is not yours.
export async function getComplaint(id: string | number): Promise<ComplaintDetail> {
  return apiFetch<ComplaintDetail>(`/api/complaints/${id}`);
}

// ---- The owner's side (day 7) ----

// A row of the owner's list: the complaint with its priority, who raised it, and where
// they live now (null once they have moved out). No phone numbers.
export type OwnerComplaintItem = ComplaintItem & {
  priority: ComplaintPriority;
  student: { id: number; name: string; isActive: boolean };
  place: { buildingName: string; roomNumber: string | null } | null;
};

// The owner's detail: the row, the timeline, and the moves allowed from the current
// status. The server decides the moves; the page only offers what it is given.
export type OwnerComplaintDetail = OwnerComplaintItem & {
  events: ComplaintEvent[];
  allowedMoves: ComplaintStatus[];
};

// The list's filters, as they appear in the page address and the request. All optional;
// from and to are 'YYYY-MM-DD' (India's dates, both included).
export const OWNER_FILTERS = ["status", "priority", "category", "buildingId", "from", "to", "page"] as const;
export type OwnerComplaintQuery = Partial<Record<(typeof OWNER_FILTERS)[number], string>>;

// The owner's note: trimmed, at most 500 characters counted as the database counts them.
export const NOTE_MAX = 500;
export const noteLength = (text: string) => [...text.trim()].length;

// GET /api/complaints as the owner: active first, high priority first, oldest first,
// 20 a page. Empty filters are left out.
export async function listOwnerComplaints(
  query: OwnerComplaintQuery,
): Promise<{ items: OwnerComplaintItem[]; total: number }> {
  const params = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const qs = params.toString();
  return apiFetch(`/api/complaints${qs ? `?${qs}` : ""}`);
}

// GET /api/complaints/:id as the owner. 404 "complaint_not_found".
export async function getOwnerComplaint(id: string | number): Promise<OwnerComplaintDetail> {
  return apiFetch<OwnerComplaintDetail>(`/api/complaints/${id}`);
}

// POST /api/complaints/:id/status. `from` is the status the page shows; if it changed
// meanwhile the server answers 409 "status_changed". Other refusals: 409
// "illegal_transition", "category_active"; 400 "note_required", "note_too_long".
export async function changeComplaintStatus(
  id: number,
  change: { from: ComplaintStatus; to: ComplaintStatus; note: string | null },
): Promise<OwnerComplaintDetail> {
  return apiFetch<OwnerComplaintDetail>(`/api/complaints/${id}/status`, { method: "POST", body: change });
}

// PATCH /api/complaints/:id: the priority, nothing else.
export async function setComplaintPriority(id: number, priority: ComplaintPriority): Promise<OwnerComplaintDetail> {
  return apiFetch<OwnerComplaintDetail>(`/api/complaints/${id}`, { method: "PATCH", body: { priority } });
}

// POST /api/complaints/:id/notes. 400 "note_required", "note_too_long".
export async function addComplaintNote(id: number, note: string): Promise<OwnerComplaintDetail> {
  return apiFetch<OwnerComplaintDetail>(`/api/complaints/${id}/notes`, { method: "POST", body: { note } });
}

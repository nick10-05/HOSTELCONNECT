import { apiFetch } from "./client";

// A student's complaints. Shapes match server/src/routes/complaints.ts and
// services/complaints.ts. Day 6 is text only; photos arrive on day 8.

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

export type ComplaintStatus = "open" | "in_progress" | "resolved" | "rejected";

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

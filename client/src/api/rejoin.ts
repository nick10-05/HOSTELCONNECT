import { apiFetch } from "./client";
import type { Admission, ReactivationForm } from "./students";

// Rejoin requests. Shapes match server/src/routes/rejoin.ts.

// POST /api/rejoin-requests, public. Returns the server's sentence, which is the same
// whoever the email belongs to. Refusals arrive as ApiError: 400 "invalid_input",
// 429 "rate_limited".
export async function requestAccess(email: string, message: string): Promise<string> {
  const answer = await apiFetch<{ message: string }>("/api/rejoin-requests", {
    method: "POST",
    body: { email, message },
  });
  return answer.message;
}

// ---- The owner's review ----

export type RejoinStatus = "pending" | "approved" | "rejected";

// Dates are India's dates, 'YYYY-MM-DD'.
export type RejoinRequestItem = {
  id: number;
  status: RejoinStatus;
  message: string | null;
  requestedOn: string;
  decidedOn: string | null;
  decidedByName: string | null;
  student: { id: number; name: string; email: string; isActive: boolean; leftOn: string | null };
};

// GET /api/rejoin-requests: pending (oldest first) or decided (newest first), 20 a page.
export async function listRejoinRequests(
  status: "pending" | "decided",
  page: number,
): Promise<{ items: RejoinRequestItem[]; total: number }> {
  return apiFetch(`/api/rejoin-requests?status=${status}&page=${page}`);
}

// POST /api/rejoin-requests/:id/approve: reactivates the student; the temporary password
// is shown once. Refusals arrive as ApiError: 409 "request_decided", "bed_occupied",
// "joining_before_leaving", ...; 404 "request_not_found".
export async function approveRejoinRequest(id: number, form: ReactivationForm): Promise<Admission> {
  return apiFetch<Admission>(`/api/rejoin-requests/${id}/approve`, { method: "POST", body: form });
}

// POST /api/rejoin-requests/:id/reject. Refusals: 409 "request_decided"; 404.
export async function rejectRejoinRequest(id: number): Promise<void> {
  await apiFetch(`/api/rejoin-requests/${id}/reject`, { method: "POST" });
}

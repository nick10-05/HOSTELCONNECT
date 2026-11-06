import { apiFetch } from "./client";

// Fees. Shapes match server/src/routes/fees.ts and services/fees.ts. Dates are
// 'YYYY-MM-DD', India's calendar; amounts are rupees, null when no monthly fee was set when
// the row was created. Rows are created by the hourly job a week before each due date.

export type FeeStatus = "pending" | "paid";
// A row's state on India's today: paid, or pending and overdue (due before today), due
// (today) or upcoming (later).
export type FeeState = "paid" | "overdue" | "due" | "upcoming";

export type MyFeeRow = {
  id: number;
  dueDate: string;
  amount: number | null;
  status: FeeStatus;
  paidOn: string | null;
  note: string | null;
};

export type MyFees = {
  pendingBalance: number; // pending fees due on or before today
  amountNotSet: number; // how many of those have no amount (they add nothing)
  overdue: MyFeeRow[]; // oldest first
  upcoming: MyFeeRow[]; // soonest first
  history: MyFeeRow[]; // every row, newest due date first
  nextDueDate: string | null;
};

export type OwnerFeeRow = {
  id: number;
  studentId: number;
  studentName: string;
  isActive: boolean; // false: moved out (the fee can still be marked)
  buildingId: number | null;
  buildingName: string | null;
  dueDate: string;
  amount: number | null;
  status: FeeStatus;
  state: FeeState;
  paidOn: string | null;
  note: string | null;
};

export type FeeTotal = { count: number; amount: number };
export type FeeTotals = { paid: FeeTotal; pending: FeeTotal; overdue: FeeTotal; amountNotSet: number };
export type FeeList = { items: OwnerFeeRow[]; total: number; totals: FeeTotals };

export type FeeFilter = {
  month?: string; // 'YYYY-MM'; India's current month when left out
  status?: "paid" | "pending" | "overdue";
  buildingId?: number;
  page?: number;
};

// The server's limit on a payment note: trimmed, at most 200 characters, counted as the
// database counts them (an emoji is one character, not two).
export const NOTE_MAX = 200;
export const noteLength = (text: string) => [...text.trim()].length;

// GET /api/fees (owner): one month's rows, 20 a page, by due date then name, with the
// month's totals (by building, not by state).
export async function listFees(filter: FeeFilter = {}): Promise<FeeList> {
  const query = new URLSearchParams();
  if (filter.month) query.set("month", filter.month);
  if (filter.status) query.set("status", filter.status);
  if (filter.buildingId !== undefined) query.set("buildingId", String(filter.buildingId));
  query.set("page", String(filter.page ?? 1));
  return apiFetch<FeeList>(`/api/fees?${query}`);
}

// POST /api/fees/:id/status (owner). Paid: `paidOn` defaults to India's today and may not
// be after it (400 "paid_on_in_future"); the student is notified. Pending: an undo, which
// clears the payment date and note and notifies nobody. 409 "fee_already_paid" /
// "fee_already_pending"; 404 "fee_not_found".
export async function markFeePaid(id: number, paidOn?: string, note?: string): Promise<MyFeeRow> {
  return apiFetch<MyFeeRow>(`/api/fees/${id}/status`, {
    method: "POST",
    body: { status: "paid", ...(paidOn ? { paidOn } : {}), ...(note?.trim() ? { note: note.trim() } : {}) },
  });
}

export async function markFeePending(id: number): Promise<MyFeeRow> {
  return apiFetch<MyFeeRow>(`/api/fees/${id}/status`, { method: "POST", body: { status: "pending" } });
}

// GET /api/fees/mine (student): their own fees and balance.
export async function getMyFees(): Promise<MyFees> {
  return apiFetch<MyFees>("/api/fees/mine");
}

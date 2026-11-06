import { apiFetch } from "./client";

// Return polls: "who is back?" after a holiday. Shapes match server/src/routes/returnPolls.ts
// and services/returnPolls.ts. Starting a poll notifies every current student; one poll may
// be open at a time, and closing is final. A poll covers the students who are active now.

// Times are ISO timestamps.
export type PollStatus = "open" | "closed";
export type PollResponse = "returned" | "not_yet";
export type PollCounts = { returned: number; notYet: number; noResponse: number };

export type ReturnPoll = {
  id: number;
  title: string;
  status: PollStatus;
  createdAt: string;
  closedAt: string | null;
};
export type PollWithCounts = ReturnPoll & { counts: PollCounts };

// A student in a results list, with the building and room of their current stay.
export type PollStudent = {
  studentId: number;
  name: string;
  buildingId: number | null;
  buildingName: string | null;
  roomNumber: string | null;
};
export type PollAnswer = PollStudent & { respondedAt: string };

export type PollResults = {
  poll: ReturnPoll;
  counts: PollCounts;
  returned: PollAnswer[];
  notYet: PollAnswer[];
  noResponse: PollStudent[];
};

// A student's view of an open poll, with their own answer (null before they answer).
export type MyOpenPoll = {
  id: number;
  title: string;
  createdAt: string;
  myResponse: PollResponse | null;
  respondedAt: string | null;
};

// The server's limit: trimmed, then 1 to 120 characters, counted as the database counts
// them (an emoji is one character, not two).
export const POLL_TITLE_MAX = 120;
export const titleLength = (text: string) => [...text.trim()].length;

// GET /api/return-polls (owner): newest first with counts, 20 a page.
export async function listPolls(page = 1): Promise<{ items: PollWithCounts[]; total: number }> {
  return apiFetch(`/api/return-polls?page=${page}`);
}

// GET /api/return-polls (student): the open poll, if any, with their own answer.
export async function listMyOpenPolls(): Promise<MyOpenPoll[]> {
  const { items } = await apiFetch<{ items: MyOpenPoll[]; total: number }>("/api/return-polls");
  return items;
}

// POST /api/return-polls (owner). 409 "poll_already_open" while another poll is open.
export async function startPoll(title: string): Promise<ReturnPoll> {
  return apiFetch<ReturnPoll>("/api/return-polls", { method: "POST", body: { title } });
}

// GET /api/return-polls/:id (owner), optionally for one building. 404 "poll_not_found".
export async function getPollResults(id: number, buildingId?: number): Promise<PollResults> {
  const query = buildingId === undefined ? "" : `?${new URLSearchParams({ buildingId: String(buildingId) })}`;
  return apiFetch<PollResults>(`/api/return-polls/${id}${query}`);
}

// POST /api/return-polls/:id/close (owner). 409 "poll_closed" if it already is.
export async function closePoll(id: number): Promise<ReturnPoll> {
  return apiFetch<ReturnPoll>(`/api/return-polls/${id}/close`, { method: "POST" });
}

// PUT /api/return-polls/:id/response (student): answers, or changes the answer, while the
// poll is open. 409 "poll_closed" once it is closed.
export async function answerPoll(
  id: number,
  response: PollResponse,
): Promise<{ pollId: number; response: PollResponse; respondedAt: string }> {
  return apiFetch(`/api/return-polls/${id}/response`, { method: "PUT", body: { response } });
}

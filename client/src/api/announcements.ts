import { apiFetch } from "./client";

// The owner's notices to every student. Shapes match server/src/routes/announcements.ts
// and services/announcements.ts. Posting notifies every current student once; editing,
// pinning and marking urgent never notify again; deleting also removes the notice from
// every student's notifications.

// Times are ISO timestamps.
export type Announcement = {
  id: number;
  title: string;
  body: string;
  isUrgent: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NewAnnouncement = { title: string; body: string; isUrgent: boolean; isPinned: boolean };
export type AnnouncementChanges = Partial<NewAnnouncement>;

// The server's limits: trimmed, then 1 to 120 and 1 to 2000 characters, counted as the
// database counts them (an emoji is one character, not two).
export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
export const textLength = (text: string) => [...text.trim()].length;

// GET /api/announcements: pinned first, then newest, 20 a page. Owner and students alike.
export async function listAnnouncements(page = 1): Promise<{ items: Announcement[]; total: number }> {
  return apiFetch(`/api/announcements?page=${page}`);
}

// POST /api/announcements (owner). 400 "invalid_input" for a bad title or body.
export async function postAnnouncement(notice: NewAnnouncement): Promise<Announcement> {
  return apiFetch<Announcement>("/api/announcements", { method: "POST", body: notice });
}

// PATCH /api/announcements/:id (owner): only the fields given. 404 "announcement_not_found".
export async function updateAnnouncement(id: number, changes: AnnouncementChanges): Promise<Announcement> {
  return apiFetch<Announcement>(`/api/announcements/${id}`, { method: "PATCH", body: changes });
}

// DELETE /api/announcements/:id (owner). Answers 204 with no body. 404 "announcement_not_found".
export async function deleteAnnouncement(id: number): Promise<void> {
  await apiFetch(`/api/announcements/${id}`, { method: "DELETE" });
}

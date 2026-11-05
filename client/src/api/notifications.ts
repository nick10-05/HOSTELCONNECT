import { apiFetch } from "./client";

// The bell. Shapes match server/src/routes/notifications.ts and services/notifications.ts.

export type NotificationItem = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null; // a path inside the app, such as /complaints/42
  createdAt: string; // an ISO timestamp
  readAt: string | null;
};

export type NotificationList = { items: NotificationItem[]; total: number; unread: number };

// GET /api/notifications: the latest 20 of your own, newest first, and the unread count.
export async function listNotifications(): Promise<NotificationList> {
  return apiFetch<NotificationList>("/api/notifications");
}

// POST /api/notifications/:id/read. 404 "notification_not_found" if it is not yours.
export async function markNotificationRead(id: number): Promise<void> {
  await apiFetch(`/api/notifications/${id}/read`, { method: "POST" });
}

// POST /api/notifications/read-all.
export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch("/api/notifications/read-all", { method: "POST" });
}

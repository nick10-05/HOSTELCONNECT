import type { Queryable } from "../db";
import { HttpError } from "../lib/http";

// In-app notifications (design doc, sections 3, 5 and 9): one row per person per event,
// shown by the bell, which the app polls about once a minute. Nothing is pushed.
// tests/notify.test.ts describes notify; tests/notifications.test.ts the rest.

// Section 3's six types; migration 008 refuses any other.
export type NotificationType =
  | "announcement"
  | "return_poll"
  | "complaint_update"
  | "fee_reminder"
  | "payment_update"
  | "daily_digest";

export type NotificationInput = {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  dedupKey?: string | null;
};

// Creates one notification per recipient, and returns how many were created.
export async function notify(
  c: Queryable,
  to: number[] | "active_students",
  n: NotificationInput,
): Promise<number> {
  if (Array.isArray(to) && to.length === 0) {
    return 0;
  }

  const isList = Array.isArray(to);

  const recipientCondition = isList
    ? "id = ANY($1::bigint[]) AND is_active = true"
    : "role = 'student' AND is_active = true";

  const values = isList
    ? "$2, $3, $4, $5, $6"
    : "$1, $2, $3, $4, $5";

  const params = isList
    ? [
        to,
        n.type,
        n.title,
        n.body ?? null,
        n.link ?? null,
        n.dedupKey ?? null,
      ]
    : [
        n.type,
        n.title,
        n.body ?? null,
        n.link ?? null,
        n.dedupKey ?? null,
      ];

  const { rowCount } = await c.query(
    `INSERT INTO notifications (
       user_id, type, title, body, link, dedup_key
     )
     SELECT id, ${values}
     FROM users
     WHERE ${recipientCondition}
     ON CONFLICT (user_id, dedup_key)
       WHERE dedup_key IS NOT NULL
     DO NOTHING`,
    params,
  );

  return rowCount ?? 0;
}

// ---- The bell (Claude) ----

export type NotificationItem = {
  id: number;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
};

// A person's own notifications, newest first; how many they have in all; and how many
// are unread, for the bell's count.
export async function listNotifications(
  db: Queryable,
  userId: number,
  page: { page: number; limit: number },
): Promise<{ items: NotificationItem[]; total: number; unread: number }> {
  const { rows: counted } = await db.query<{ total: number; unread: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE read_at IS NULL)::int AS unread
     FROM notifications
     WHERE user_id = $1`,
    [userId],
  );

  const { rows } = await db.query<NotificationItem>(
    `SELECT id, type, title, body, link,
            created_at AS "createdAt",
            read_at AS "readAt"
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, page.limit, (page.page - 1) * page.limit],
  );

  return {
    items: rows,
    total: counted[0].total,
    unread: counted[0].unread,
  };
}

// Marks one of the person's own notifications read.
// 404 notification_not_found
export async function markRead(
  db: Queryable,
  userId: number,
  id: number,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE notifications
     SET read_at = coalesce(read_at, now())
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );

  if (rowCount === 0) {
    throw new HttpError(
      404,
      "notification_not_found",
      "That notification does not exist.",
    );
  }
}

// Marks all of the person's unread notifications read, and returns how many there were.
export async function markAllRead(
  db: Queryable,
  userId: number,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE notifications
     SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );

  return rowCount ?? 0;
}
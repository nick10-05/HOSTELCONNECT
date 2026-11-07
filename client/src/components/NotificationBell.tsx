import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { BellIcon } from "../ui/icons";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
  type NotificationList,
} from "../api/notifications";

// The bell in the header (design doc, sections 2 and 9), for the owner and students
// alike. The app asks the server about once a minute instead of keeping a connection
// open, and only while the tab is visible, so a tab in the background does not keep the
// free server awake. A failed check changes nothing on screen: the next one tries again.

export const POLL_MS = 60_000;

// '5 Nov, 10:00 am', in India's time, whatever the device's zone.
const timeFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export function NotificationBell() {
  const [list, setList] = useState<NotificationList | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    listNotifications()
      .then(setList)
      .catch(() => {
        // Keep what is shown; the next check tries again.
      });
  }, []);

  // Checks now, then every minute while the tab is visible, and as soon as it is shown again.
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Escape or a click outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const toggle = () => {
    if (!open) load();
    setOpen((o) => !o);
  };

  // Shown as read at once; if the server disagrees, the next check corrects it.
  const markRead = (n: NotificationItem) => {
    if (n.readAt) return;
    setList((l) =>
      l && {
        ...l,
        unread: Math.max(0, l.unread - 1),
        items: l.items.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)),
      },
    );
    markNotificationRead(n.id).catch(load);
  };

  const markAll = () => {
    const now = new Date().toISOString();
    setList((l) => l && { ...l, unread: 0, items: l.items.map((i) => ({ ...i, readAt: i.readAt ?? now })) });
    markAllNotificationsRead().catch(load);
  };

  const unread = list?.unread ?? 0;

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-controls={panelId}
        className="press relative flex size-11 items-center justify-center rounded-[15px] border border-line bg-surface text-ink shadow-card hover:bg-soft"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-5 rounded-full bg-rose-600 px-1 text-center text-[11px] leading-5 font-bold text-white ring-2 ring-[var(--hc-bg)]"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          // On a phone the bell is not at the screen's edge (Sign out is), so a panel
          // lined up with it ran off the left side: there it spans the header bar, just
          // under it. (The bar's blur makes it the box a fixed panel is placed in.) From
          // sm up it hangs under the bell.
          className="fixed inset-x-0 top-[calc(100%+0.75rem)] z-40 border border-line bg-surface animate-[sheet-up_0.35s_cubic-bezier(0.2,0.9,0.25,1)_both] overflow-hidden rounded-3xl shadow-[0_24px_50px_-18px_rgb(10_10_15/0.45)] sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-3 sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id={headingId} className="text-base font-extrabold text-ink">
              Notifications
            </h2>
            <button
              type="button"
              onClick={markAll}
              disabled={unread === 0}
              className="min-h-11 rounded-lg px-2 text-sm font-semibold text-[var(--hc-accent)] hover:bg-soft disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent"
            >
              Mark all read
            </button>
          </div>
          {!list || list.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              {list ? "No notifications yet." : "Loading…"}
            </p>
          ) : (
            <ul className="max-h-[60dvh] divide-y divide-line overflow-y-auto sm:max-h-96">
              {list.items.map((n) => (
                <li key={n.id}>
                  <Entry
                    notification={n}
                    onOpen={() => {
                      markRead(n);
                      if (n.link) setOpen(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// One notification: a link when it leads somewhere, otherwise a button that marks it read.
function Entry({ notification: n, onOpen }: { notification: NotificationItem; onOpen: () => void }) {
  const content = (
    <>
      <p className={`text-sm ${n.readAt ? "text-muted" : "font-semibold text-ink"}`}>{n.title}</p>
      {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
      <span className="mt-1 flex items-center gap-2 text-xs text-faint">
        {formatTime(n.createdAt)}
        {!n.readAt && <span className="hc-pill-violet rounded-full px-1.5 font-semibold">Unread</span>}
      </span>
    </>
  );
  const className = `block w-full px-4 py-3 text-left hover:bg-soft ${n.readAt ? "" : "bg-soft/70"}`;
  return n.link ? (
    <Link to={n.link} onClick={onOpen} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onOpen} className={className}>
      {content}
    </button>
  );
}

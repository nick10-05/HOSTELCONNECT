import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
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
        className="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-xs leading-5 font-semibold text-white"
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
          // lined up with it ran off the left side: there it spans the screen, 16px in
          // from each side. From sm up it hangs under the bell.
          className="fixed inset-x-4 top-14 z-10 rounded-xl border border-slate-200 bg-white shadow-lg sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-80"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <h2 id={headingId} className="text-sm font-semibold text-slate-700">
              Notifications
            </h2>
            <button
              type="button"
              onClick={markAll}
              disabled={unread === 0}
              className="text-sm font-medium text-indigo-700 hover:underline disabled:cursor-default disabled:text-slate-400 disabled:no-underline"
            >
              Mark all read
            </button>
          </div>
          {!list || list.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">
              {list ? "No notifications yet." : "Loading…"}
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
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
      <p className={`text-sm ${n.readAt ? "text-slate-700" : "font-semibold text-slate-900"}`}>{n.title}</p>
      {n.body && <span className="mt-0.5 block text-sm text-slate-600">{n.body}</span>}
      <span className="mt-1 flex items-center gap-2 text-xs text-slate-500">
        {formatTime(n.createdAt)}
        {!n.readAt && <span className="rounded-full bg-indigo-50 px-1.5 font-medium text-indigo-700">Unread</span>}
      </span>
    </>
  );
  const className = `block w-full px-4 py-3 text-left hover:bg-slate-50 ${n.readAt ? "" : "bg-indigo-50/40"}`;
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

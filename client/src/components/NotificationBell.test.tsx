import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem, NotificationList } from "../api/notifications";
import { jsonResponse, mockFetch } from "../test/fetch";
import { NotificationBell, POLL_MS } from "./NotificationBell";

const water: NotificationItem = {
  id: 2,
  type: "announcement",
  title: "Water off on Sunday",
  body: "From 9 to 12.",
  link: "/announcements/5",
  createdAt: "2026-11-05T04:30:00.000Z", // 10:00 am in India
  readAt: null,
};
const fees: NotificationItem = {
  id: 1,
  type: "fee_reminder",
  title: "Fee due in 3 days",
  body: null,
  link: null,
  createdAt: "2026-11-04T04:30:00.000Z",
  readAt: null,
};
const seen: NotificationItem = { ...fees, id: 0, title: "An older notice", readAt: "2026-11-03T05:00:00.000Z" };

// Whether the tab is visible: the bell only polls while it is.
let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
});

// A fake server: each GET answers the next list (the last one again after that), and
// each POST is recorded and answered 204, or 200 for read-all.
function fakeServer(lists: NotificationList[]) {
  const gets: string[] = [];
  const posts: string[] = [];
  mockFetch(async (url, init) => {
    if (init?.method === "POST") {
      posts.push(url);
      return url.endsWith("/read-all") ? jsonResponse(200, { marked: 2 }) : new Response(null, { status: 204 });
    }
    gets.push(url);
    return jsonResponse(200, lists[Math.min(gets.length - 1, lists.length - 1)]);
  });
  return { gets, posts };
}

function renderBell() {
  // Only the polling tests use a fake clock; user-event must then move it along.
  const user = userEvent.setup(vi.isFakeTimers() ? { advanceTimers: (ms) => vi.advanceTimersByTime(ms) } : {});
  render(
    <MemoryRouter initialEntries={["/"]}>
      <NotificationBell />
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/announcements/:id" element={<p>Announcement page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("NotificationBell", () => {
  it("shows how many are unread, in its name for screen readers too", async () => {
    fakeServer([{ items: [water, fees, seen], total: 3, unread: 2 }]);
    renderBell();

    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows no count when everything is read, and 9+ for more than nine", async () => {
    fakeServer([{ items: [seen], total: 1, unread: 0 }]);
    const { unmount } = render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    unmount();

    fakeServer([{ items: [water], total: 12, unread: 12 }]);
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Notifications, 12 unread" })).toHaveTextContent("9+");
  });

  it("opens a list, newest first, with unread ones marked, and loads again when opened", async () => {
    const { gets } = fakeServer([{ items: [water, fees, seen], total: 3, unread: 2 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications, 2 unread" });

    await user.click(bell());

    const panel = screen.getByRole("dialog", { name: "Notifications" });
    const items = within(panel).getAllByRole("listitem");
    expect(items.map((i) => i.querySelector("p")?.textContent)).toEqual([
      "Water off on Sunday",
      "Fee due in 3 days",
      "An older notice",
    ]);
    expect(items[0]).toHaveTextContent("From 9 to 12.");
    expect(items[0]).toHaveTextContent("5 Nov, 10:00 am");
    expect(within(items[0]).getByText("Unread")).toBeInTheDocument();
    expect(within(items[2]).queryByText("Unread")).not.toBeInTheDocument();
    expect(gets).toHaveLength(2);
    expect(bell()).toHaveAttribute("aria-expanded", "true");
  });

  it("marks a notification read and opens its link", async () => {
    const { posts } = fakeServer([{ items: [water, fees], total: 2, unread: 2 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    await user.click(bell());

    await user.click(within(screen.getByRole("dialog")).getByRole("link", { name: /Water off on Sunday/ }));

    expect(await screen.findByText("Announcement page")).toBeInTheDocument();
    expect(posts).toEqual(["/api/notifications/2/read"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bell()).toHaveAccessibleName("Notifications, 1 unread");
  });

  it("marks one without a link read where it is", async () => {
    const { posts } = fakeServer([{ items: [water, fees], total: 2, unread: 2 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    await user.click(bell());

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Fee due in 3 days/ }));

    expect(posts).toEqual(["/api/notifications/1/read"]);
    expect(bell()).toHaveAccessibleName("Notifications, 1 unread");
    const fee = within(screen.getByRole("dialog")).getAllByRole("listitem")[1];
    expect(within(fee).queryByText("Unread")).not.toBeInTheDocument();
    expect(screen.getByText("Home page")).toBeInTheDocument();
  });

  it("marks all read at once", async () => {
    const { posts } = fakeServer([{ items: [water, fees], total: 2, unread: 2 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    await user.click(bell());

    await user.click(screen.getByRole("button", { name: "Mark all read" }));

    expect(posts).toEqual(["/api/notifications/read-all"]);
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  it("says when there are none", async () => {
    fakeServer([{ items: [], total: 0, unread: 0 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications" });
    await user.click(bell());
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside", async () => {
    fakeServer([{ items: [water], total: 1, unread: 1 }]);
    const user = renderBell();
    await screen.findByRole("button", { name: "Notifications, 1 unread" });

    await user.click(bell());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bell()).toHaveFocus();

    await user.click(bell());
    await user.click(screen.getByText("Home page"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("checks again every minute while the tab is visible, and not while it is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { gets } = fakeServer([
      { items: [], total: 0, unread: 0 },
      { items: [water], total: 1, unread: 1 },
    ]);
    renderBell();
    await screen.findByRole("button", { name: "Notifications" });
    expect(gets).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(gets).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();

    visibility = "hidden";
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS * 3);
    });
    expect(gets).toHaveLength(2);
  });

  it("checks at once when the tab becomes visible again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { gets } = fakeServer([{ items: [], total: 0, unread: 0 }]);
    renderBell();
    await screen.findByRole("button", { name: "Notifications" });

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(gets).toHaveLength(1);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(gets).toHaveLength(2);
  });

  it("keeps quiet when a check fails, and shows the count again once one succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = true;
    mockFetch(async () =>
      fail ? jsonResponse(503, { error: { code: "db_unavailable", message: "Down" } }) : jsonResponse(200, { items: [water], total: 1, unread: 1 }),
    );
    renderBell();
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fail = false;
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
    });
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();
  });
});

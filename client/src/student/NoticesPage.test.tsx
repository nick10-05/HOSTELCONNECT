import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Announcement } from "../api/announcements";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ImportantNotices, NoticesPage } from "./NoticesPage";

const water: Announcement = {
  id: 1,
  title: "Water off on Sunday",
  body: "The tank is being cleaned from 9 am to 1 pm.\nPlease store water the night before.",
  isUrgent: true,
  isPinned: false,
  createdAt: "2026-11-04T03:30:00.000Z", // 9:00 am in India
  updatedAt: "2026-11-04T03:30:00.000Z",
};
const mess: Announcement = { ...water, id: 2, title: "Mess timings", body: "Dinner 7 to 9 pm.", isUrgent: false, isPinned: true };
const plain: Announcement = { ...water, id: 3, title: "Laundry day", body: "Wednesdays.", isUrgent: false, isPinned: false };

function fakeServer(page: (n: number) => Response) {
  const gets: string[] = [];
  mockFetch(async (url) => {
    const n = url.match(/^\/api\/announcements\?page=(\d+)$/)?.[1];
    if (!n) return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
    gets.push(url);
    return page(Number(n));
  });
  return { gets };
}

function renderIt(element: React.ReactNode) {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={["/notices"]}>{element}</MemoryRouter>);
  return user;
}

describe("NoticesPage", () => {
  it("lists the notices in the server's order, with Urgent and Pinned shown, and nothing to change", async () => {
    const { gets } = fakeServer(() => jsonResponse(200, { items: [mess, water, plain], total: 3 }));
    renderIt(<NoticesPage />);

    const list = await screen.findByRole("list", { name: "Notices" });
    expect(gets).toEqual(["/api/announcements?page=1"]);
    const articles = within(list).getAllByRole("article");
    expect(articles.map((a) => a.getAttribute("aria-labelledby"))).toEqual(["notice-2", "notice-1", "notice-3"]);
    expect(articles[0]).toHaveTextContent("Pinned");
    expect(articles[1]).toHaveTextContent("Urgent");
    expect(articles[1]).toHaveTextContent("Please store water the night before.");
    expect(articles[1]).toHaveTextContent("Posted 4 Nov 2026, 9:00 am");
    expect(articles[2]).not.toHaveTextContent("Urgent");
    expect(articles[2]).not.toHaveTextContent("Pinned");
    // Students only read.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps the notice's line breaks", async () => {
    fakeServer(() => jsonResponse(200, { items: [water], total: 1 }));
    renderIt(<NoticesPage />);
    expect(await screen.findByText(/Please store water/)).toHaveClass("whitespace-pre-line");
  });

  it("says when there are no notices yet", async () => {
    fakeServer(() => jsonResponse(200, { items: [], total: 0 }));
    renderIt(<NoticesPage />);
    expect(await screen.findByText("No notices yet.")).toBeInTheDocument();
  });

  it("pages through older notices", async () => {
    const { gets } = fakeServer((n) => jsonResponse(200, { items: [n === 1 ? water : plain], total: 21 }));
    const user = renderIt(<NoticesPage />);
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("article", { name: "Laundry day" })).toBeInTheDocument();
    expect(gets).toEqual(["/api/announcements?page=1", "/api/announcements?page=2"]);
  });

  it("shows the server's message when the notices cannot be loaded", async () => {
    fakeServer(() => jsonResponse(500, { error: { code: "internal", message: "Something went wrong on our side." } }));
    renderIt(<NoticesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side.");
  });
});

describe("ImportantNotices (top of the student home)", () => {
  it("shows only the urgent and pinned notices, with a link to all of them", async () => {
    fakeServer(() => jsonResponse(200, { items: [mess, water, plain], total: 3 }));
    renderIt(<ImportantNotices />);

    const box = await screen.findByRole("region", { name: "Important notices" });
    expect(within(box).getAllByRole("article").map((a) => a.getAttribute("aria-labelledby"))).toEqual([
      "notice-2",
      "notice-1",
    ]);
    expect(within(box).getByRole("link", { name: "See all notices" })).toHaveAttribute("href", "/notices");
  });

  it("shows nothing when no notice is urgent or pinned", async () => {
    const { gets } = fakeServer(() => jsonResponse(200, { items: [plain], total: 1 }));
    renderIt(<ImportantNotices />);
    await waitFor(() => expect(gets).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Important notices" })).not.toBeInTheDocument();
  });

  it("shows nothing, and no error, when the notices cannot be loaded", async () => {
    const { gets } = fakeServer(() => jsonResponse(500, { error: { code: "internal", message: "Down." } }));
    renderIt(<ImportantNotices />);
    await waitFor(() => expect(gets).toHaveLength(1));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

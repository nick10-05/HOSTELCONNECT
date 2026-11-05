import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ComplaintItem, ComplaintList, RaiseStatus } from "../api/complaints";
import { jsonResponse, mockFetch } from "../test/fetch";
import { MyComplaintsPage } from "./MyComplaintsPage";

const tap: ComplaintItem = {
  id: 42,
  category: "plumbing",
  description: "The tap in room 101 keeps dripping all night.",
  status: "open",
  createdAt: "2026-11-05T04:30:00.000Z", // 10:00 am in India
  updatedAt: "2026-11-05T04:30:00.000Z",
  resolvedAt: null,
};
const wifi: ComplaintItem = {
  ...tap,
  id: 41,
  category: "internet",
  description: "Wi-Fi drops every evening on the second floor.",
  status: "resolved",
  createdAt: "2026-11-03T13:45:00.000Z", // 7:15 pm in India
  resolvedAt: "2026-11-04T05:00:00.000Z",
};

const ALLOWED: RaiseStatus = { allowed: true, reason: null, activeCategories: ["plumbing"] };
const FULL = "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.";

// A fake server: GET /api/complaints?page=N answers with lists[N - 1] (or the last one),
// or with `failure` when given.
function fakeServer(lists: ComplaintList[], { failure }: { failure?: Response } = {}) {
  const gets: string[] = [];
  mockFetch(async (url) => {
    const page = url.match(/^\/api\/complaints\?page=(\d+)$/)?.[1];
    if (page) {
      gets.push(url);
      if (failure) return failure;
      return jsonResponse(200, lists[Math.min(Number(page), lists.length) - 1]);
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/"]}>
      <MyComplaintsPage />
    </MemoryRouter>,
  );
  return { user, gets };
}

describe("MyComplaintsPage", () => {
  it("lists the student's complaints with category, status, text and time, each opening its page", async () => {
    const { gets } = fakeServer([{ items: [tap, wifi], total: 2, canRaise: ALLOWED }]);

    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
    const first = await screen.findByRole("listitem", { name: "Plumbing" });
    expect(gets).toEqual(["/api/complaints?page=1"]);
    expect(first).toHaveTextContent("Open");
    expect(first).toHaveTextContent("The tap in room 101 keeps dripping all night.");
    expect(first).toHaveTextContent("Raised 5 Nov 2026, 10:00 am");
    expect(within(first).getByRole("link")).toHaveAttribute("href", "/complaints/42");

    const second = screen.getByRole("listitem", { name: "Internet" });
    expect(second).toHaveTextContent("Resolved");
    expect(second).toHaveTextContent("Raised 3 Nov 2026, 7:15 pm");
    expect(within(second).getByRole("link")).toHaveAttribute("href", "/complaints/41");
  });

  it("offers New complaint when a complaint is possible", async () => {
    fakeServer([{ items: [tap], total: 1, canRaise: ALLOWED }]);
    const link = await screen.findByRole("link", { name: "New complaint" });
    expect(link).toHaveAttribute("href", "/complaints/new");
  });

  it("disables New complaint and shows the server's reason when a limit is reached", async () => {
    fakeServer([{ items: [tap], total: 1, canRaise: { allowed: false, reason: FULL, activeCategories: ["plumbing"] } }]);

    const button = await screen.findByRole("button", { name: "New complaint" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(FULL);
    expect(screen.getByText(FULL)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New complaint" })).not.toBeInTheDocument();
  });

  it("says so when there are no complaints yet", async () => {
    fakeServer([{ items: [], total: 0, canRaise: { allowed: true, reason: null, activeCategories: [] } }]);
    expect(await screen.findByText("You have not raised any complaints.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New complaint" })).toBeInTheDocument();
  });

  it("pages through older complaints", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ ...tap, id: 100 + i }));
    const { user, gets } = fakeServer([
      { items: twenty, total: 21, canRaise: ALLOWED },
      { items: [wifi], total: 21, canRaise: ALLOWED },
    ]);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("listitem", { name: "Internet" })).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(gets).toEqual(["/api/complaints?page=1", "/api/complaints?page=2"]);
  });

  it("shows the server's message when the list cannot be loaded", async () => {
    fakeServer([], {
      failure: jsonResponse(403, { error: { code: "forbidden", message: "You do not have permission to access this resource" } }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to access this resource");
  });
});

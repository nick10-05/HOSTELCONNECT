import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { PollWithCounts } from "../api/returnPolls";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ReturnPollsPage } from "./ReturnPollsPage";

const open: PollWithCounts = {
  id: 6,
  title: "Back after Diwali?",
  status: "open",
  createdAt: "2032-11-02T04:30:00Z",
  closedAt: null,
  counts: { returned: 41, notYet: 3, noResponse: 12 },
};
const closed: PollWithCounts = {
  id: 5,
  title: "Back after Dussehra?",
  status: "closed",
  createdAt: "2032-10-10T04:30:00Z",
  closedAt: "2032-10-14T12:00:00Z",
  counts: { returned: 50, notYet: 0, noResponse: 6 },
};

type Call = { url: string; method: string; body: unknown };

function renderPage(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/return-polls"]}>
      <Routes>
        <Route path="/return-polls" element={<ReturnPollsPage />} />
        <Route path="/return-polls/:id" element={<p>Results page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { calls, user };
}

const list = (...items: PollWithCounts[]) => jsonResponse(200, { items, total: items.length });

describe("ReturnPollsPage", () => {
  it("lists every poll, newest first, with its state and counts, each opening its results", async () => {
    const { calls, user } = renderPage(() => list(open, closed));
    const polls = await screen.findByRole("list", { name: "Return polls" });
    const items = within(polls).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Back after Diwali?");
    expect(items[0]).toHaveTextContent("Open");
    expect(items[0]).toHaveTextContent("41 returned · 3 not yet · 12 no response");
    expect(items[1]).toHaveTextContent("Closed");
    expect(items[1]).toHaveTextContent("50 returned · 0 not yet · 6 no response");
    expect(calls.map((c) => c.url)).toEqual(["/api/return-polls?page=1"]);

    await user.click(within(items[0]).getByRole("link", { name: "Back after Diwali?" }));
    expect(await screen.findByText("Results page")).toBeInTheDocument();
  });

  it("says so when there are no polls yet", async () => {
    renderPage(() => list());
    expect(await screen.findByText("No return polls yet.")).toBeInTheDocument();
  });

  it("starts a poll, says the students were told, and shows it in the list", async () => {
    let polls: PollWithCounts[] = [closed];
    const { calls, user } = renderPage((call) => {
      if (call.method === "POST") {
        polls = [{ ...open, counts: { returned: 0, notYet: 0, noResponse: 56 } }, closed];
        return jsonResponse(201, open);
      }
      return list(...polls);
    });
    await user.type(await screen.findByLabelText("Question"), "  Back after Diwali? ");
    await user.click(screen.getByRole("button", { name: "Start poll" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Poll started. Every current student has been notified.");
    expect(calls.find((c) => c.method === "POST")).toEqual({
      url: "/api/return-polls",
      method: "POST",
      body: { title: "Back after Diwali?" },
    });
    expect(await screen.findByText("0 returned · 0 not yet · 56 no response")).toBeInTheDocument();
    // An open poll now: no second one can be started.
    expect(screen.queryByRole("button", { name: "Start poll" })).not.toBeInTheDocument();
  });

  it("offers no new poll while one is open", async () => {
    renderPage(() => list(open, closed));
    expect(await screen.findByText("Close the open poll before starting another.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Question")).not.toBeInTheDocument();
  });

  it("holds back a blank or too long question", async () => {
    const { calls, user } = renderPage(() => list());
    const field = await screen.findByLabelText("Question");
    const start = screen.getByRole("button", { name: "Start poll" });
    expect(start).toBeDisabled();
    await user.type(field, "   ");
    expect(start).toBeDisabled();
    await user.clear(field);
    await user.type(field, "x".repeat(121));
    expect(start).toBeDisabled();
    expect(screen.getByText("121 / 120")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.type(field, "{Backspace}");
    expect(start).toBeEnabled();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("shows the server's refusal and keeps the question", async () => {
    const { user } = renderPage((call) =>
      call.method === "POST"
        ? jsonResponse(409, {
            error: { code: "poll_already_open", message: "A return poll is already open. Close it before starting another." },
          })
        : list(closed),
    );
    await user.type(await screen.findByLabelText("Question"), "Back yet?");
    await user.click(screen.getByRole("button", { name: "Start poll" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A return poll is already open.");
    expect(screen.getByLabelText("Question")).toHaveValue("Back yet?");
  });

  it("shows why the list could not be loaded", async () => {
    renderPage(() => jsonResponse(500, { error: { code: "internal", message: "Something went wrong on our side." } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side.");
  });
});

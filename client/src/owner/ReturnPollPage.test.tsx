import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { PollResults } from "../api/returnPolls";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ReturnPollPage } from "./ReturnPollPage";

const results: PollResults = {
  poll: { id: 6, title: "Back after Diwali?", status: "open", createdAt: "2032-11-02T04:30:00Z", closedAt: null },
  counts: { returned: 2, notYet: 1, noResponse: 2 },
  returned: [
    { studentId: 1, name: "Asha Rao", buildingId: 1, buildingName: "Block A", roomNumber: "101", respondedAt: "2032-11-02T06:00:00Z" },
    { studentId: 2, name: "Bina Das", buildingId: 2, buildingName: "Block B", roomNumber: null, respondedAt: "2032-11-02T07:00:00Z" },
  ],
  notYet: [
    { studentId: 3, name: "Chitra K", buildingId: 1, buildingName: "Block A", roomNumber: "102", respondedAt: "2032-11-02T08:00:00Z" },
  ],
  noResponse: [
    { studentId: 4, name: "Divya M", buildingId: 2, buildingName: "Block B", roomNumber: "201" },
    { studentId: 5, name: "Esha P", buildingId: 1, buildingName: "Block A", roomNumber: null },
  ],
};
const buildings = [
  { id: 1, name: "Block A", floors: [], rooms: [] },
  { id: 2, name: "Block B", floors: [], rooms: [] },
];

function Address() {
  const location = useLocation();
  return <p data-testid="address">{location.pathname + location.search}</p>;
}

type Call = { url: string; method: string };

function renderPage(answer: (call: Call) => Response, at = "/return-polls/6") {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const call = { url, method: init?.method ?? "GET" };
    calls.push(call);
    if (url === "/api/structure") return jsonResponse(200, { buildings });
    return answer(call);
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/return-polls/:id" element={<ReturnPollPage />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
  return { calls, user };
}

const region = (name: RegExp) => screen.getByRole("region", { name });

describe("ReturnPollPage", () => {
  it("shows the poll and who has returned, who has not yet and who has not answered", async () => {
    const { calls } = renderPage(() => jsonResponse(200, results));
    expect(await screen.findByRole("heading", { name: "Back after Diwali?" })).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();

    const returned = region(/^Returned/);
    expect(within(returned).getByRole("heading")).toHaveTextContent("Returned (2)");
    expect(within(returned).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Asha RaoBlock A · Room 101"),
      expect.stringContaining("Bina DasBlock B"),
    ]);
    expect(within(region(/^Not yet/)).getByRole("heading")).toHaveTextContent("Not yet (1)");
    expect(within(region(/^Not yet/)).getByText("Chitra K")).toBeInTheDocument();
    expect(within(region(/^No response/)).getByRole("heading")).toHaveTextContent("No response (2)");
    expect(within(region(/^No response/)).getByText("Block B · Room 201")).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain("/api/return-polls/6");
  });

  it("says when a list is empty", async () => {
    renderPage(() => jsonResponse(200, { ...results, counts: { returned: 0, notYet: 0, noResponse: 0 }, returned: [], notYet: [], noResponse: [] }));
    expect(await screen.findAllByText("Nobody.")).toHaveLength(3);
  });

  it("filters by building and keeps it in the address", async () => {
    const { calls, user } = renderPage((call) =>
      jsonResponse(200, call.url.endsWith("?buildingId=2") ? { ...results, returned: [results.returned[1]], notYet: [], noResponse: [results.noResponse[0]] } : results),
    );
    await user.selectOptions(await screen.findByLabelText("Building"), "Block B");
    expect(await screen.findByTestId("address")).toHaveTextContent("/return-polls/6?building=2");
    expect(calls.map((c) => c.url)).toContain("/api/return-polls/6?buildingId=2");
    expect(await screen.findByText("Nobody.")).toBeInTheDocument();
  });

  it("opens with the building from the address", async () => {
    const { calls } = renderPage(() => jsonResponse(200, results), "/return-polls/6?building=1");
    await screen.findByRole("heading", { name: "Back after Diwali?" });
    expect(calls.map((c) => c.url)).toContain("/api/return-polls/6?buildingId=1");
    expect(await screen.findByLabelText("Building")).toHaveValue("1");
  });

  it("links to the food counts of the students who returned", async () => {
    renderPage(() => jsonResponse(200, results));
    expect(await screen.findByRole("link", { name: "Food counts for those who returned" })).toHaveAttribute(
      "href",
      "/food-counts?pollId=6",
    );
  });

  it("closes the poll after asking, then shows it closed", async () => {
    let closed = false;
    const { calls, user } = renderPage((call) => {
      if (call.method === "POST") {
        closed = true;
        return jsonResponse(200, { ...results.poll, status: "closed", closedAt: "2032-11-05T10:00:00Z" });
      }
      return jsonResponse(200, closed ? { ...results, poll: { ...results.poll, status: "closed", closedAt: "2032-11-05T10:00:00Z" } } : results);
    });
    await user.click(await screen.findByRole("button", { name: "Close poll" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const confirm = screen.getByRole("group", { name: "Confirm close" });
    expect(confirm).toHaveTextContent("Students can no longer answer once it is closed. This cannot be undone.");
    await user.click(within(confirm).getByRole("button", { name: "Yes, close it" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Poll closed.");
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/return-polls/6/close");
    expect(await screen.findByText(/^Closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close poll" })).not.toBeInTheDocument();
  });

  it("can cancel closing", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, results));
    await user.click(await screen.findByRole("button", { name: "Close poll" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm close" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("offers no close on a closed poll", async () => {
    renderPage(() => jsonResponse(200, { ...results, poll: { ...results.poll, status: "closed", closedAt: "2032-11-05T10:00:00Z" } }));
    await screen.findByRole("heading", { name: "Back after Diwali?" });
    expect(screen.queryByRole("button", { name: "Close poll" })).not.toBeInTheDocument();
  });

  it("shows the server's answer for an unknown poll", async () => {
    renderPage(() => jsonResponse(404, { error: { code: "poll_not_found", message: "That poll does not exist." } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That poll does not exist.");
  });
});

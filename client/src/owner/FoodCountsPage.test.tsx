import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { FoodCounts } from "../api/food";
import { jsonResponse, mockFetch } from "../test/fetch";
import { FoodCountsPage } from "./FoodCountsPage";

const tuesday: FoodCounts = {
  date: "2032-06-15",
  weekday: 2,
  pollId: null,
  overall: { veg: 70, nonVeg: 54, total: 124 },
  buildings: [
    { buildingId: 1, buildingName: "Block A", veg: 68, nonVeg: 52, total: 120 },
    { buildingId: 2, buildingName: "Block B", veg: 2, nonVeg: 2, total: 4 },
    { buildingId: 3, buildingName: "New wing", veg: 0, nonVeg: 0, total: 0 },
  ],
};

// Shows the address the page put in the bar, so tests can check the chosen date is kept.
function Address() {
  const location = useLocation();
  return <p data-testid="address">{location.pathname + location.search}</p>;
}

const polls = [
  { id: 6, title: "Back after Diwali?", status: "open", createdAt: "2032-06-10T04:30:00Z", closedAt: null, counts: { returned: 41, notYet: 3, noResponse: 12 } },
  { id: 5, title: "Back after Holi?", status: "closed", createdAt: "2032-03-20T04:30:00Z", closedAt: "2032-03-25T04:30:00Z", counts: { returned: 50, notYet: 0, noResponse: 6 } },
];

// `requested` holds the food-count requests only; the poll list (for the "Count" choice)
// is answered here, or with `pollList` when a test gives one.
function renderPage(answer: (url: string) => Response, at = "/food-counts", pollList?: () => Response) {
  const requested: string[] = [];
  mockFetch(async (url) => {
    if (url === "/api/return-polls?page=1") {
      return pollList ? pollList() : jsonResponse(200, { items: polls, total: polls.length });
    }
    requested.push(url);
    return answer(url);
  });
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/food-counts" element={<FoodCountsPage />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
  return requested;
}

const region = (name: string) => screen.getByRole("region", { name });

describe("FoodCountsPage", () => {
  it("shows today's counts, overall and per building, from one request", async () => {
    const requested = renderPage(() => jsonResponse(200, tuesday));
    expect(await screen.findByText("Tuesday, 15 Jun 2032")).toBeInTheDocument();
    expect(requested).toEqual(["/api/food-counts"]);

    const overall = region("All buildings");
    expect(within(overall).getByText("Veg").nextSibling).toHaveTextContent("70");
    expect(within(overall).getByText("Non-veg").nextSibling).toHaveTextContent("54");
    expect(within(overall).getByText("Total").nextSibling).toHaveTextContent("124");

    const rows = within(region("By building")).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "BuildingVegNon-vegTotal",
      "Block A6852120",
      "Block B224",
      "New wing000",
    ]);
    // The date field shows the day the server counted.
    expect(screen.getByLabelText("Date")).toHaveValue("2032-06-15");
  });

  it("explains that veg days are counted as veg", async () => {
    renderPage(() => jsonResponse(200, tuesday));
    expect(
      await screen.findByText("Non-veg students who eat veg on Tuesdays are counted as veg."),
    ).toBeInTheDocument();
  });

  it("asks for the date in the address", async () => {
    const requested = renderPage(
      () => jsonResponse(200, { ...tuesday, date: "2032-06-20", weekday: 7 }),
      "/food-counts?date=2032-06-20",
    );
    expect(await screen.findByText("Sunday, 20 Jun 2032")).toBeInTheDocument();
    expect(requested).toEqual(["/api/food-counts?date=2032-06-20"]);
  });

  it("counts for another date when one is picked, and keeps it in the address", async () => {
    const requested = renderPage((url) =>
      url.endsWith("date=2032-06-14")
        ? jsonResponse(200, { ...tuesday, date: "2032-06-14", weekday: 1 })
        : jsonResponse(200, tuesday),
    );
    await screen.findByText("Tuesday, 15 Jun 2032");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2032-06-14" } });
    expect(await screen.findByText("Monday, 14 Jun 2032")).toBeInTheDocument();
    expect(requested).toEqual(["/api/food-counts", "/api/food-counts?date=2032-06-14"]);
    expect(screen.getByTestId("address")).toHaveTextContent("/food-counts?date=2032-06-14");

    // "Today" goes back to the server's today.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByText("Tuesday, 15 Jun 2032")).toBeInTheDocument();
    expect(screen.getByTestId("address")).toHaveTextContent(/^\/food-counts$/);
  });

  it("points to Buildings when there are none yet", async () => {
    renderPage(() => jsonResponse(200, { ...tuesday, overall: { veg: 0, nonVeg: 0, total: 0 }, buildings: [] }));
    expect(await screen.findByText(/No buildings yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buildings and rooms" })).toHaveAttribute("href", "/structure");
  });

  it("shows the server's message when the counts cannot be loaded", async () => {
    renderPage(() =>
      jsonResponse(400, { error: { code: "invalid_input", message: "date: must be a date written as YYYY-MM-DD" } }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("date: must be a date written as YYYY-MM-DD");
  });

  it("counts only those who returned in a chosen poll, and keeps the poll in the address", async () => {
    const requested = renderPage((url) =>
      jsonResponse(200, url.endsWith("pollId=6") ? { ...tuesday, pollId: 6, overall: { veg: 30, nonVeg: 11, total: 41 } } : tuesday),
    );
    const count = await screen.findByLabelText("Count");
    expect(within(count).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Every current student",
      "Returned in: Back after Diwali? (open)",
      "Returned in: Back after Holi?",
    ]);
    fireEvent.change(count, { target: { value: "6" } });

    expect(await screen.findByText(`Only students who answered "I'm back" to Back after Diwali?.`)).toBeInTheDocument();
    expect(requested).toEqual(["/api/food-counts", "/api/food-counts?pollId=6"]);
    expect(screen.getByTestId("address")).toHaveTextContent("/food-counts?pollId=6");
    expect(within(region("All buildings")).getByText("Total").nextSibling).toHaveTextContent("41");

    fireEvent.change(count, { target: { value: "" } });
    expect(await screen.findByTestId("address")).toHaveTextContent(/^\/food-counts$/);
  });

  it("asks for the date and the poll in the address together, and keeps the poll when the date changes", async () => {
    const requested = renderPage(
      (url) => jsonResponse(200, { ...tuesday, pollId: url.includes("pollId=5") ? 5 : null }),
      "/food-counts?date=2032-06-20&pollId=5",
    );
    expect(await screen.findByText(`Only students who answered "I'm back" to Back after Holi?.`)).toBeInTheDocument();
    expect(requested[0]).toBe("/api/food-counts?date=2032-06-20&pollId=5");
    expect(screen.getByLabelText("Count")).toHaveValue("5");

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2032-06-14" } });
    expect(await screen.findByTestId("address")).toHaveTextContent("/food-counts?date=2032-06-14&pollId=5");
    // And the other way round: another poll keeps the date.
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "6" } });
    expect(await screen.findByTestId("address")).toHaveTextContent("/food-counts?date=2032-06-14&pollId=6");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByTestId("address")).toHaveTextContent(/^\/food-counts\?pollId=6$/);
  });

  it("still shows the counts when the polls cannot be loaded, without the choice", async () => {
    renderPage(
      () => jsonResponse(200, tuesday),
      "/food-counts",
      () => jsonResponse(500, { error: { code: "internal", message: "Down." } }),
    );
    expect(await screen.findByText("Tuesday, 15 Jun 2032")).toBeInTheDocument();
    expect(screen.queryByLabelText("Count")).not.toBeInTheDocument();
  });
});

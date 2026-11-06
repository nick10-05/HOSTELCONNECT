import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { FoodCounts } from "../api/food";
import { jsonResponse, mockFetch } from "../test/fetch";
import { FoodCountsPage } from "./FoodCountsPage";

const tuesday: FoodCounts = {
  date: "2032-06-15",
  weekday: 2,
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

function renderPage(answer: (url: string) => Response, at = "/food-counts") {
  const requested: string[] = [];
  mockFetch(async (url) => {
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
});

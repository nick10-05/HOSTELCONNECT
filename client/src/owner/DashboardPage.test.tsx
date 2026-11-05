import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Dashboard } from "../api/dashboard";
import { jsonResponse, mockFetch } from "../test/fetch";
import { DashboardPage } from "./DashboardPage";

const full: Dashboard = {
  students: {
    total: 124,
    joiningLater: 1,
    buildings: [
      { id: 1, name: "Block A", students: 120, joiningLater: 1, beds: { total: 90, occupied: 84, vacant: 6 } },
      { id: 2, name: "Block B", students: 4, joiningLater: 0, beds: null },
      { id: 3, name: "New wing", students: 0, joiningLater: 0, beds: { total: 1, occupied: 0, vacant: 1 } },
    ],
  },
  rejoinRequests: { pending: 2, oldestRequestedOn: "2026-11-03" },
};

function renderPage(answer: () => Response) {
  const requested: string[] = [];
  mockFetch(async (url) => {
    requested.push(url);
    return answer();
  });
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  return requested;
}

const region = (name: string) => screen.getByRole("region", { name });

describe("DashboardPage", () => {
  it("loads every card with one request", async () => {
    const requested = renderPage(() => jsonResponse(200, full));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Students" });
    expect(requested).toEqual(["/api/dashboard"]);
  });

  it("shows students per building, with vacant beds where there are beds", async () => {
    renderPage(() => jsonResponse(200, full));
    const students = await screen.findByRole("region", { name: "Students" });

    expect(students).toHaveTextContent("124 current students, including 1 joining later");
    const rows = within(students).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Block A");
    expect(rows[0]).toHaveTextContent("120 students (1 joining later)");
    expect(rows[0]).toHaveTextContent("6 of 90 beds vacant");
    expect(rows[1]).toHaveTextContent("4 students");
    expect(rows[1]).toHaveTextContent("No beds yet");
    expect(rows[2]).toHaveTextContent("0 students");
    expect(rows[2]).toHaveTextContent("1 of 1 bed vacant");
  });

  it("says how many rejoin requests wait, since when, and links to them", async () => {
    renderPage(() => jsonResponse(200, full));
    const requests = await screen.findByRole("region", { name: "Rejoin requests" });

    expect(requests).toHaveTextContent("2 waiting, the oldest since 3 Nov 2026");
    expect(within(requests).getByRole("link", { name: "Review requests" })).toHaveAttribute("href", "/rejoin-requests");
  });

  it("shows the quiet states: no buildings, no students and no requests", async () => {
    renderPage(() =>
      jsonResponse(200, {
        students: { total: 0, joiningLater: 0, buildings: [] },
        rejoinRequests: { pending: 0, oldestRequestedOn: null },
      }),
    );

    const students = await screen.findByRole("region", { name: "Students" });
    expect(students).toHaveTextContent("No buildings yet.");
    expect(within(students).getByRole("link", { name: "Buildings and rooms" })).toHaveAttribute("href", "/structure");
    expect(region("Rejoin requests")).toHaveTextContent("None waiting.");
    expect(within(region("Rejoin requests")).queryByRole("link")).not.toBeInTheDocument();
  });

  it("says one request and one student in the singular", async () => {
    renderPage(() =>
      jsonResponse(200, {
        students: {
          total: 1,
          joiningLater: 0,
          buildings: [{ id: 1, name: "Block A", students: 1, joiningLater: 0, beds: { total: 2, occupied: 1, vacant: 1 } }],
        },
        rejoinRequests: { pending: 1, oldestRequestedOn: "2026-11-04" },
      }),
    );

    const students = await screen.findByRole("region", { name: "Students" });
    expect(students).toHaveTextContent("1 current student");
    expect(within(students).getByRole("listitem")).toHaveTextContent("1 student");
    expect(region("Rejoin requests")).toHaveTextContent("1 waiting, since 4 Nov 2026");
  });

  it("shows the server's message when the dashboard cannot be loaded", async () => {
    renderPage(() => jsonResponse(503, { error: { code: "db_unavailable", message: "Database is unreachable" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Database is unreachable");
  });
});

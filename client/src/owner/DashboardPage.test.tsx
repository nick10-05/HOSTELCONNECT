import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Dashboard, UsageCard } from "../api/dashboard";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ageText, DashboardPage } from "./DashboardPage";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const NO_COMPLAINTS = { active: 0, highPriority: 0, oldestActiveAt: null };
const MB = 1024 * 1024;
// Day 8: the storage and bandwidth card, at rest.
const QUIET_USAGE: UsageCard = {
  storage: { usedBytes: Math.round(12.34 * MB), limitBytes: 450 * MB, percent: 2 },
  egress: { month: "2026-11", usedBytes: Math.round(1.5 * MB), limitBytes: 3000 * MB, percent: 0 },
  level: "ok",
  uploadsAllowed: true,
  failingDeletions: 0,
  photosConfigured: true,
};
// Day 9: nothing pending.
const NO_FEES = {
  dueSoon: { count: 0, amount: 0 },
  overdue: { count: 0, amount: 0 },
  pendingThisMonth: { count: 0, amount: 0 },
};

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
  complaints: { active: 3, highPriority: 1, oldestActiveAt: hoursAgo(3 * 24 + 2) },
  usage: QUIET_USAGE,
  returnPoll: {
    id: 7,
    title: "Back after Diwali?",
    createdAt: hoursAgo(30),
    counts: { returned: 41, notYet: 3, noResponse: 12 },
  },
  fees: {
    dueSoon: { count: 5, amount: 32500 },
    overdue: { count: 2, amount: 13000 },
    pendingThisMonth: { count: 9, amount: 58500 },
  },
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

  it("shows active complaints, the high-priority ones and how long the oldest has waited", async () => {
    renderPage(() => jsonResponse(200, full));
    const complaints = await screen.findByRole("region", { name: "Complaints" });
    expect(complaints).toHaveTextContent("3 active, 1 high priority, the oldest waiting 3 days");
    // The owner's complaint list (day 7).
    expect(within(complaints).getByRole("link", { name: "Open complaints" })).toHaveAttribute("href", "/complaints");
  });

  it("shows the open return poll's counts and links to its results", async () => {
    renderPage(() => jsonResponse(200, full));
    const poll = await screen.findByRole("region", { name: "Return poll" });
    expect(poll).toHaveTextContent("Back after Diwali?");
    expect(poll).toHaveTextContent("41 returned · 3 not yet · 12 no response");
    expect(within(poll).getByRole("link", { name: "See who is back" })).toHaveAttribute("href", "/return-polls/7");
    expect(within(poll).queryByRole("link", { name: "Start a return poll" })).not.toBeInTheDocument();
  });

  it("offers to start a return poll while none is open", async () => {
    renderPage(() => jsonResponse(200, { ...full, returnPoll: null }));
    const poll = await screen.findByRole("region", { name: "Return poll" });
    expect(poll).toHaveTextContent("No poll open.");
    expect(within(poll).getByRole("link", { name: "Start a return poll" })).toHaveAttribute("href", "/return-polls");
    expect(within(poll).queryByRole("link", { name: "See who is back" })).not.toBeInTheDocument();
  });

  it("shows fees due soon, overdue and pending this month, and links to Fees", async () => {
    renderPage(() => jsonResponse(200, full));
    const fees = await screen.findByRole("region", { name: "Fees" });
    expect(within(fees).getAllByRole("term").map((t) => t.textContent)).toEqual([
      "Due in the next 7 days",
      "Overdue",
      "Pending this month",
    ]);
    expect(within(fees).getAllByRole("definition").map((d) => d.textContent)).toEqual([
      "5 fees · ₹32,500",
      "2 fees · ₹13,000",
      "9 fees · ₹58,500",
    ]);
    expect(within(fees).getByRole("link", { name: "Open fees" })).toHaveAttribute("href", "/fees");
  });

  it("says when no fees are pending", async () => {
    renderPage(() => jsonResponse(200, { ...full, fees: NO_FEES }));
    const fees = await screen.findByRole("region", { name: "Fees" });
    expect(fees).toHaveTextContent("No fees pending.");
    expect(within(fees).queryByRole("term")).not.toBeInTheDocument();
    expect(within(fees).getByRole("link", { name: "Open fees" })).toHaveAttribute("href", "/fees");
  });

  it("says one fee in the singular, and ₹0 for a fee with no amount set", async () => {
    renderPage(() =>
      jsonResponse(200, {
        ...full,
        fees: { ...NO_FEES, overdue: { count: 1, amount: 0 }, pendingThisMonth: { count: 1, amount: 0 } },
      }),
    );
    const fees = await screen.findByRole("region", { name: "Fees" });
    expect(within(fees).getAllByRole("definition").map((d) => d.textContent)).toEqual([
      "0 fees · ₹0",
      "1 fee · ₹0",
      "1 fee · ₹0",
    ]);
  });

  it("puts the cards in the design's order: students, return poll, complaints, rejoin requests, fees, then usage", async () => {
    renderPage(() => jsonResponse(200, full));
    await screen.findByRole("region", { name: "Students" });
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"))).toEqual([
      "card-students",
      "card-return-poll",
      "card-complaints",
      "card-requests",
      "card-fees",
      "card-usage",
    ]);
  });

  it("shows the quiet states: no buildings, no students and no requests", async () => {
    renderPage(() =>
      jsonResponse(200, {
        students: { total: 0, joiningLater: 0, buildings: [] },
        rejoinRequests: { pending: 0, oldestRequestedOn: null },
        complaints: NO_COMPLAINTS,
        usage: QUIET_USAGE,
        returnPoll: null,
        fees: NO_FEES,
      }),
    );

    const students = await screen.findByRole("region", { name: "Students" });
    expect(students).toHaveTextContent("No buildings yet.");
    expect(within(students).getByRole("link", { name: "Buildings and rooms" })).toHaveAttribute("href", "/structure");
    expect(region("Rejoin requests")).toHaveTextContent("None waiting.");
    expect(within(region("Rejoin requests")).queryByRole("link")).not.toBeInTheDocument();
    expect(region("Complaints")).toHaveTextContent("None open.");
    // Past complaints are still there to look at.
    expect(within(region("Complaints")).getByRole("link", { name: "Open complaints" })).toHaveAttribute(
      "href",
      "/complaints",
    );
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
        complaints: { active: 1, highPriority: 0, oldestActiveAt: hoursAgo(5.5) },
        usage: QUIET_USAGE,
        returnPoll: null,
        fees: NO_FEES,
      }),
    );

    const students = await screen.findByRole("region", { name: "Students" });
    expect(students).toHaveTextContent("1 current student");
    expect(within(students).getByRole("listitem")).toHaveTextContent("1 student");
    expect(region("Rejoin requests")).toHaveTextContent("1 waiting, since 4 Nov 2026");
    expect(region("Complaints")).toHaveTextContent("1 active, waiting 5 hours");
    expect(region("Complaints")).not.toHaveTextContent("high priority");
  });

  it("shows photo storage and this month's bandwidth against their limits", async () => {
    renderPage(() => jsonResponse(200, full));
    const usage = await screen.findByRole("region", { name: "Storage and bandwidth" });
    expect(usage).toHaveTextContent("Photos stored12.3 MB of 450 MB (2%)");
    expect(usage).toHaveTextContent("Bandwidth in November 20261.5 MB of 3,000 MB (0%)");
    expect(within(usage).queryByRole("alert")).not.toBeInTheDocument();
    expect(usage).toHaveTextContent("Photo uploads are on.");
  });

  it("turns amber at 70% and says when uploads will switch off", async () => {
    renderPage(() =>
      jsonResponse(200, { ...full, usage: { ...QUIET_USAGE, storage: { ...QUIET_USAGE.storage, percent: 72 }, level: "amber" } }),
    );
    const usage = await screen.findByRole("region", { name: "Storage and bandwidth" });
    expect(within(usage).getByRole("status")).toHaveTextContent(
      "Over 70% of a free limit. Photo uploads switch off at 85%.",
    );
  });

  it("says photo uploads are off at 85%, and when the bandwidth count starts again", async () => {
    renderPage(() =>
      jsonResponse(200, {
        ...full,
        usage: { ...QUIET_USAGE, egress: { ...QUIET_USAGE.egress, percent: 91 }, level: "uploads_off", uploadsAllowed: false },
      }),
    );
    const usage = await screen.findByRole("region", { name: "Storage and bandwidth" });
    const alert = within(usage).getByRole("alert");
    expect(alert).toHaveTextContent(
      "Photo uploads are off: usage has reached 85% of a free limit. Students can still send complaints as text.",
    );
    expect(alert).toHaveTextContent("The bandwidth count starts again on 1 December 2026.");
  });

  it("does not promise a bandwidth reset when storage is what is full", async () => {
    renderPage(() =>
      jsonResponse(200, {
        ...full,
        usage: { ...QUIET_USAGE, storage: { ...QUIET_USAGE.storage, percent: 86 }, level: "uploads_off", uploadsAllowed: false },
      }),
    );
    const alert = within(await screen.findByRole("region", { name: "Storage and bandwidth" })).getByRole("alert");
    expect(alert).not.toHaveTextContent("starts again");
    expect(alert).toHaveTextContent("Space frees up as photos are deleted 48 hours after upload.");
  });

  it("warns when photos have failed to delete five times", async () => {
    renderPage(() => jsonResponse(200, { ...full, usage: { ...QUIET_USAGE, failingDeletions: 2 } }));
    const usage = await screen.findByRole("region", { name: "Storage and bandwidth" });
    expect(within(usage).getByRole("alert")).toHaveTextContent(
      "2 photos could not be deleted after 5 tries. The hourly job keeps trying; check Supabase Storage.",
    );
  });

  it("says when photo storage is not set up", async () => {
    renderPage(() => jsonResponse(200, { ...full, usage: { ...QUIET_USAGE, photosConfigured: false } }));
    const usage = await screen.findByRole("region", { name: "Storage and bandwidth" });
    expect(usage).toHaveTextContent("Photo storage is not set up, so complaints are text only.");
    expect(usage).not.toHaveTextContent("Photos stored");
  });

  it("shows the server's message when the dashboard cannot be loaded", async () => {
    renderPage(() => jsonResponse(503, { error: { code: "db_unavailable", message: "Database is unreachable" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Database is unreachable");
  });
});

describe("ageText", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  it("says under an hour, then hours, then whole days", () => {
    expect(ageText(at(0.5), now)).toBe("under an hour");
    expect(ageText(at(1), now)).toBe("1 hour");
    expect(ageText(at(23.9), now)).toBe("23 hours");
    expect(ageText(at(24), now)).toBe("1 day");
    expect(ageText(at(24 * 9 + 20), now)).toBe("9 days");
  });
});

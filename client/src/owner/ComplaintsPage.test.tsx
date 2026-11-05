import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { OwnerComplaintItem } from "../api/complaints";
import type { Building } from "../api/structure";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ComplaintsPage } from "./ComplaintsPage";

const blockA: Building = { id: 1, name: "Block A", floors: [], rooms: [] };

const tap: OwnerComplaintItem = {
  id: 1,
  category: "plumbing",
  description: "The tap in room 101 keeps dripping.\nIt wakes me up at night.",
  status: "open",
  priority: "high",
  createdAt: "2026-11-04T03:30:00.000Z", // 9:00 am in India
  updatedAt: "2026-11-04T03:30:00.000Z",
  resolvedAt: null,
  student: { id: 7, name: "Asha Rao", isActive: true },
  place: { buildingName: "Block A", roomNumber: "101" },
};
const fan: OwnerComplaintItem = {
  ...tap,
  id: 2,
  category: "electrical",
  description: "The fan does not turn on.",
  status: "resolved",
  priority: "normal",
  resolvedAt: "2026-11-05T03:30:00.000Z",
  student: { id: 9, name: "Esha Former", isActive: false },
  place: null,
};

// A fake server: the buildings for the filter, and a list answered by `page`.
function fakeServer(page: (query: URLSearchParams) => { items: OwnerComplaintItem[]; total: number }) {
  const queries: URLSearchParams[] = [];
  mockFetch(async (url) => {
    if (url === "/api/structure") return jsonResponse(200, { buildings: [blockA] });
    if (url === "/api/complaints" || url.startsWith("/api/complaints?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      queries.push(query);
      return jsonResponse(200, page(query));
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const last = () => Object.fromEntries(queries[queries.length - 1]);
  return { queries, last };
}

function Address() {
  const location = useLocation();
  return <output aria-label="address">{location.pathname + location.search}</output>;
}

function renderAt(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/complaints"
          element={
            <>
              <ComplaintsPage />
              <Address />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

const address = () => screen.getByRole("status", { name: "address" }).textContent;

describe("ComplaintsPage", () => {
  it("lists complaints with the student, where they live, status, priority and time", async () => {
    fakeServer(() => ({ items: [tap, fan], total: 2 }));
    renderAt("/complaints");

    const list = await screen.findByRole("list", { name: "Complaints" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Plumbing #1");
    expect(rows[0]).toHaveTextContent("The tap in room 101 keeps dripping.");
    expect(rows[0]).not.toHaveTextContent("It wakes me up"); // first line only
    expect(rows[0]).toHaveTextContent("Asha Rao · Block A · Room 101");
    expect(rows[0]).toHaveTextContent("Open");
    expect(rows[0]).toHaveTextContent("High priority");
    expect(rows[0]).toHaveTextContent("Raised 4 Nov 2026, 9:00 am");
    expect(within(rows[0]).getByRole("link", { name: "Plumbing #1" })).toHaveAttribute("href", "/complaints/1");
    // A moved-out student has no place.
    expect(rows[1]).toHaveTextContent("Esha Former · Moved out");
    expect(rows[1]).toHaveTextContent("Resolved");
    expect(screen.getByText("2 complaints")).toBeInTheDocument();
  });

  it("asks the server with no filters at first, in its own order", async () => {
    const server = fakeServer(() => ({ items: [tap], total: 1 }));
    renderAt("/complaints");
    await screen.findByRole("list", { name: "Complaints" });
    expect(server.last()).toEqual({});
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("puts each filter in the address and the request, back on page 1", async () => {
    const server = fakeServer(() => ({ items: [tap], total: 1 }));
    const user = renderAt("/complaints?page=3");
    await screen.findByRole("list", { name: "Complaints" });

    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await user.selectOptions(screen.getByLabelText("Priority"), "high");
    await user.selectOptions(screen.getByLabelText("Category"), "plumbing");
    await user.selectOptions(await screen.findByLabelText("Building"), "1");

    await waitFor(() =>
      expect(server.last()).toEqual({ status: "open", priority: "high", category: "plumbing", buildingId: "1" }),
    );
    expect(address()).toBe("/complaints?status=open&priority=high&category=plumbing&buildingId=1");
  });

  it("filters by dates, both ends", async () => {
    const server = fakeServer(() => ({ items: [tap], total: 1 }));
    const user = renderAt("/complaints");
    await screen.findByRole("list", { name: "Complaints" });

    await user.type(screen.getByLabelText("From"), "2026-11-01");
    await user.type(screen.getByLabelText("To"), "2026-11-05");

    await waitFor(() => expect(server.last()).toEqual({ from: "2026-11-01", to: "2026-11-05" }));
  });

  it("reads the filters from the address, and clears them", async () => {
    const server = fakeServer(() => ({ items: [tap], total: 1 }));
    const user = renderAt("/complaints?status=resolved&from=2026-11-01");
    await screen.findByRole("list", { name: "Complaints" });
    expect(server.last()).toEqual({ status: "resolved", from: "2026-11-01" });
    expect(screen.getByLabelText("Status")).toHaveValue("resolved");
    expect(screen.getByLabelText("From")).toHaveValue("2026-11-01");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(server.last()).toEqual({}));
    expect(address()).toBe("/complaints");
  });

  it("pages through the list, 20 at a time", async () => {
    const server = fakeServer((q) => ({ items: [q.get("page") === "2" ? fan : tap], total: 25 }));
    const user = renderAt("/complaints?status=open");
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(server.last()).toEqual({ status: "open", page: "2" });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("says when there are no complaints at all, and when none match", async () => {
    fakeServer(() => ({ items: [], total: 0 }));
    renderAt("/complaints");
    expect(await screen.findByText("No complaints yet.")).toBeInTheDocument();
  });

  it("says when no complaint matches the filters", async () => {
    fakeServer(() => ({ items: [], total: 0 }));
    renderAt("/complaints?priority=low");
    expect(await screen.findByText("No complaints match these filters.")).toBeInTheDocument();
  });

  it("shows the server's message when the list cannot be loaded", async () => {
    mockFetch(async (url) =>
      url === "/api/structure"
        ? jsonResponse(200, { buildings: [] })
        : jsonResponse(400, { error: { code: "invalid_input", message: "from: must not be after to" } }),
    );
    renderAt("/complaints?from=2026-11-05&to=2026-11-01");
    expect(await screen.findByRole("alert")).toHaveTextContent("from: must not be after to");
  });
});

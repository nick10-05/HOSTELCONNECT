import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { jsonResponse, mockFetch } from "./test/fetch";

const owner = { id: 1, name: "Owner", role: "owner", mustChangePassword: false };

const urgentNotice = {
  id: 5,
  title: "Water off on Sunday",
  body: "Store water the night before.",
  isUrgent: true,
  isPinned: false,
  createdAt: "2026-11-04T03:30:00.000Z",
  updatedAt: "2026-11-04T03:30:00.000Z",
};

const ownerComplaint = {
  id: 1,
  category: "plumbing",
  description: "The tap keeps dripping.",
  status: "open",
  priority: "normal",
  createdAt: "2026-11-04T03:30:00.000Z",
  updatedAt: "2026-11-04T03:30:00.000Z",
  resolvedAt: null,
  student: { id: 7, name: "Asha Rao", isActive: true },
  place: { buildingName: "Block A", roomNumber: "101" },
};

function renderAt(path: string) {
  mockFetch(async (url) => {
    if (url === "/api/auth/me") return jsonResponse(200, { user: owner });
    if (url === "/api/structure") return jsonResponse(200, { buildings: [] });
    if (url.startsWith("/api/rejoin-requests?")) return jsonResponse(200, { items: [], total: 0 });
    if (url === "/api/notifications") return jsonResponse(200, { items: [], total: 0, unread: 0 });
    if (url === "/api/complaints") return jsonResponse(200, { items: [ownerComplaint], total: 1 });
    if (url === "/api/announcements?page=1") return jsonResponse(200, { items: [urgentNotice], total: 1 });
    if (url === "/api/complaints/1") {
      return jsonResponse(200, { ...ownerComplaint, events: [], allowedMoves: ["in_progress", "resolved", "rejected"] });
    }
    if (url === "/api/dashboard") {
      return jsonResponse(200, {
        students: { total: 0, joiningLater: 0, buildings: [] },
        rejoinRequests: { pending: 0, oldestRequestedOn: null },
        complaints: { active: 0, highPriority: 0, oldestActiveAt: null },
      });
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
}

describe("owner pages", () => {
  it("starts on the dashboard and moves between pages with the menu", async () => {
    const user = renderAt("/");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Admit student" }));
    expect(await screen.findByRole("heading", { name: "Admit a student" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Admit student" })).toHaveAttribute("aria-current", "page");
    // Only the home page highlights Dashboard.
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("has a Students page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Students" }));
    expect(await screen.findByRole("heading", { name: "Students" })).toBeInTheDocument();
  });

  it("has a Rejoin requests page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Rejoin requests" }));
    expect(await screen.findByRole("heading", { name: "Rejoin requests" })).toBeInTheDocument();
  });

  it("has a Complaints page in the menu, which opens a complaint", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Complaints" }));
    expect(await screen.findByRole("heading", { name: "Complaints" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complaints" })).toHaveAttribute("aria-current", "page");

    await user.click(await screen.findByRole("link", { name: "Plumbing #1" }));
    expect(await screen.findByRole("heading", { name: "Plumbing #1" })).toBeInTheDocument();
  });

  it("has an Announcements page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Announcements" }));
    expect(await screen.findByRole("heading", { name: "Announcements" })).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "Water off on Sunday" })).toBeInTheDocument();
  });

  it("sends the students' Notices address to the dashboard", async () => {
    renderAt("/notices");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("has the notification bell in the header", async () => {
    renderAt("/structure");
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });

  it("opens a page straight from its address", async () => {
    renderAt("/students/new");
    expect(await screen.findByRole("heading", { name: "Admit a student" })).toBeInTheDocument();
  });

  it("sends an unknown address to the dashboard", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });
});

describe("student pages", () => {
  const student = { id: 7, name: "Asha Rao", role: "student", mustChangePassword: false };

  function renderStudentAt(path: string) {
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(200, { user: student });
      if (url === "/api/notifications") return jsonResponse(200, { items: [], total: 0, unread: 0 });
      if (url === "/api/complaints?page=1") {
        return jsonResponse(200, { items: [], total: 0, canRaise: { allowed: true, reason: null, activeCategories: [] } });
      }
      if (url === "/api/announcements?page=1") return jsonResponse(200, { items: [urgentNotice], total: 1 });
      return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    return user;
  }

  it("start on My complaints, with the bell and no owner menu", async () => {
    renderStudentAt("/");
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Owner pages" })).not.toBeInTheDocument();
  });

  it("open the complaint form from the list and come back", async () => {
    const user = renderStudentAt("/");
    await user.click(await screen.findByRole("link", { name: "New complaint" }));
    expect(await screen.findByRole("heading", { name: "New complaint" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "← My complaints" }));
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
  });

  it("send an owner page's address, or an unknown one, to My complaints", async () => {
    renderStudentAt("/students");
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
  });

  it("see urgent and pinned notices at the top of their home, and reach Notices from their menu", async () => {
    const user = renderStudentAt("/");
    const box = await screen.findByRole("region", { name: "Important notices" });
    expect(box).toHaveTextContent("Water off on Sunday");
    expect(screen.getByRole("navigation", { name: "Student pages" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My complaints" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Notices" }));
    expect(await screen.findByRole("heading", { name: "Notices" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notices" })).toHaveAttribute("aria-current", "page");
  });

  it("never see the owner's Announcements page", async () => {
    renderStudentAt("/announcements");
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Announcements" })).not.toBeInTheDocument();
  });

  it("never see the owner's complaint list at /complaints", async () => {
    renderStudentAt("/complaints");
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Complaints" })).not.toBeInTheDocument();
  });
});

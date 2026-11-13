import { render, screen, within } from "@testing-library/react";
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

const ownerPoll = {
  id: 6,
  title: "Back after Diwali?",
  status: "open",
  createdAt: "2026-11-02T04:30:00.000Z",
  closedAt: null,
  counts: { returned: 0, notYet: 0, noResponse: 3 },
};

function renderAt(path: string) {
  mockFetch(async (url) => {
    if (url === "/api/auth/me") return jsonResponse(200, { user: owner });
    if (url === "/api/structure") return jsonResponse(200, { buildings: [] });
    if (url.startsWith("/api/rejoin-requests?")) return jsonResponse(200, { items: [], total: 0 });
    if (url === "/api/notifications") return jsonResponse(200, { items: [], total: 0, unread: 0 });
    if (url === "/api/complaints") return jsonResponse(200, { items: [ownerComplaint], total: 1 });
    if (url === "/api/announcements?page=1") return jsonResponse(200, { items: [urgentNotice], total: 1 });
    if (url === "/api/return-polls?page=1") return jsonResponse(200, { items: [ownerPoll], total: 1 });
    if (url === "/api/settings/payment") {
      return jsonResponse(200, { upiId: "owner@okaxis", upiPayeeName: null, qrUrl: null, updatedAt: "2026-11-02T04:30:00.000Z" });
    }
    if (url === "/api/fees?page=1") return jsonResponse(200, { items: [], total: 0, totals: { paid: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, amountNotSet: 0 } });
    if (url === "/api/return-polls/6") {
      return jsonResponse(200, { poll: ownerPoll, counts: ownerPoll.counts, returned: [], notYet: [], noResponse: [] });
    }
    if (url === "/api/complaints/1") {
      return jsonResponse(200, { ...ownerComplaint, events: [], allowedMoves: ["in_progress", "resolved", "rejected"] });
    }
    if (url === "/api/dashboard") {
      return jsonResponse(200, {
        students: { total: 0, joiningLater: 0, buildings: [] },
        rejoinRequests: { pending: 0, oldestRequestedOn: null },
        complaints: { active: 0, highPriority: 0, oldestActiveAt: null },
        // Day 8: the storage and bandwidth card.
        usage: {
          storage: { usedBytes: 0, limitBytes: 450 * 1024 * 1024, percent: 0 },
          hostelStorage: { usedBytes: 0, limitBytes: 450 * 1024 * 1024, percent: 0 },
          egress: { month: "2026-11", usedBytes: 0, limitBytes: 3000 * 1024 * 1024, percent: 0 },
          level: "ok",
          uploadsAllowed: true,
          failingDeletions: 0,
          photosConfigured: false,
        },
        // Day 9: the return poll and fees cards.
        returnPoll: null,
        fees: {
          dueSoon: { count: 0, amount: 0 },
          overdue: { count: 0, amount: 0 },
          pendingThisMonth: { count: 0, amount: 0 },
        },
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
    // The redesign names the dashboard's tab "Home", like the students' first tab.
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Admit student" }));
    expect(await screen.findByRole("heading", { name: "Admit a student" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Admit student" })).toHaveAttribute("aria-current", "page");
    // Only the home page highlights Home.
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("opens the other pages from More, as a menu that slides up on a phone", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More pages" });
    for (const name of ["Buildings", "Admit student", "Rejoin requests", "Announcements", "Return polls", "Food counts", "Settings"]) {
      expect(within(sheet).getByRole("link", { name })).toBeInTheDocument();
    }

    await user.click(within(sheet).getByRole("link", { name: "Food counts" }));
    expect(await screen.findByRole("heading", { name: "Food counts" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "More pages" })).not.toBeInTheDocument();
  });

  it("has Sign out in the header", async () => {
    renderAt("/structure");
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
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

  it("has a Return polls page in the menu, which opens a poll's results", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Return polls" }));
    expect(await screen.findByRole("heading", { name: "Return polls" })).toBeInTheDocument();
    await user.click(await screen.findByRole("link", { name: "Back after Diwali?" }));
    expect(await screen.findByRole("heading", { name: "Back after Diwali?" })).toBeInTheDocument();
    // Still highlighted on a poll's own page.
    expect(screen.getByRole("link", { name: "Return polls" })).toHaveAttribute("aria-current", "page");
  });

  it("has a Fees page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Fees" }));
    expect(await screen.findByRole("heading", { name: "Fees" })).toBeInTheDocument();
    expect(await screen.findByText("No fees match.")).toBeInTheDocument();
  });

  it("has the payment settings in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Payment settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("UPI ID")).toHaveValue("owner@okaxis");
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
      if (url === "/api/fees/mine") return jsonResponse(200, { pendingBalance: 6500, amountNotSet: 0, overdue: [], upcoming: [], history: [], nextDueDate: "2026-12-14" });
      if (url === "/api/return-polls") {
        const poll = { id: 6, title: "Back after Diwali?", createdAt: "2026-11-02T04:30:00.000Z", myResponse: null, respondedAt: null };
        return jsonResponse(200, { items: [poll], total: 1 });
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

  it("see an open return poll on their home, after the important notices and before their complaints", async () => {
    renderStudentAt("/");
    const poll = await screen.findByRole("region", { name: "Back after Diwali?" });
    const notices = await screen.findByRole("region", { name: "Important notices" });
    const complaints = await screen.findByRole("heading", { name: "My complaints" });
    expect(notices.compareDocumentPosition(poll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(poll.compareDocumentPosition(complaints) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'm back" })).toBeInTheDocument();
  });

  it("see their fees at the end of their home, and open My fees from the card and the menu", async () => {
    const user = renderStudentAt("/");
    const card = await screen.findByRole("region", { name: "My fees" });
    const complaints = await screen.findByRole("heading", { name: "My complaints" });
    expect(complaints.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card).toHaveTextContent("₹6,500");

    await user.click(screen.getByRole("link", { name: "See my fees" }));
    expect(await screen.findByRole("heading", { name: "My fees", level: 1 })).toBeInTheDocument();
    const menu = screen.getByRole("navigation", { name: "Student pages" });
    expect(within(menu).getByRole("link", { name: "My fees" })).toHaveAttribute("aria-current", "page");
    expect(within(menu).getByRole("link", { name: "My complaints" })).not.toHaveAttribute("aria-current");
  });

  it("never see the owner's Return polls page", async () => {
    renderStudentAt("/return-polls");
    expect(await screen.findByRole("heading", { name: "My complaints" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Return polls" })).not.toBeInTheDocument();
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

// Signed out (Safe Browsing "Deceptive pages", 2026-11-10): the sign-in form only at the
// app's own addresses; anywhere else "Page not found", never a password field.
describe("signed out", () => {
  function renderSignedOutAt(path: string) {
    mockFetch(async (url) => {
      if (url === "/api/auth/options") return jsonResponse(200, { google: true, signupsOpen: false });
      if (url === "/api/hostels/sns-hostel") return jsonResponse(200, { hostel: { name: "SNS Hostel", slug: "sns-hostel" } });
      return jsonResponse(401, { error: { code: "unauthenticated", message: "Please sign in." } });
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  // The mixed-case ones: React Router ignores case unless told not to, while the server's
  // list of pages does not, so these answer 404 and must not show a form either.
  it.each([
    "/paypal/signin",
    "/office365/verify-account",
    "/login/verify",
    "/h/sns-hostel/verify",
    "/H/sns-hostel/login",
    "/h/sns-hostel/LOGIN",
    "/H/sns-hostel/request-access",
    "/SIGNUP",
    "/Request-Access",
    "/LOGIN",
  ])(
    "%s says the page was not found, with no sign-in form",
    async (path) => {
      renderSignedOutAt(path);
      expect(await screen.findByRole("heading", { name: "Page not found", level: 1 })).toBeInTheDocument();
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /sign in with google/i })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
      expect(document.title).toBe("Page not found · HostelConnect");
    },
  );

  it.each(["/", "/login", "/students/12"])("%s still shows sign-in", async (path) => {
    renderSignedOutAt(path);
    expect(await screen.findByLabelText("Your hostel's address")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Page not found" })).not.toBeInTheDocument();
  });

  it("a hostel's own page still shows its password sign-in", async () => {
    renderSignedOutAt("/h/sns-hostel/login");
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });
});

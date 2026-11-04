import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { RejoinRequestItem } from "../api/rejoin";
import type { Building } from "../api/structure";
import { jsonResponse, mockFetch } from "../test/fetch";
import { hostelToday } from "./admissionForm";
import { RejoinRequestsPage } from "./RejoinRequestsPage";

const blockA: Building = { id: 1, name: "Block A", floors: [], rooms: [] };

const ravi: RejoinRequestItem = {
  id: 3,
  status: "pending",
  message: "Back for my final year.",
  requestedOn: "2026-11-02",
  decidedOn: null,
  decidedByName: null,
  student: { id: 7, name: "Ravi Kumar", email: "ravi@example.com", isActive: false, leftOn: "2026-06-30" },
};
const meera: RejoinRequestItem = {
  ...ravi,
  id: 4,
  message: null,
  student: { ...ravi.student, id: 8, name: "Meera Joshi", email: "meera@example.com" },
};
const decided: RejoinRequestItem = {
  ...ravi,
  id: 2,
  status: "approved",
  decidedOn: "2026-11-03",
  decidedByName: "Test Owner",
  student: { ...ravi.student, id: 9, name: "Arjun Rao", isActive: true },
};

type List = { items: RejoinRequestItem[]; total: number };

// A fake server: GET /api/rejoin-requests answers each list in turn (the last one again
// after that), GET /api/structure one building, and each POST to
// /api/rejoin-requests/:id/<action> is recorded and answered by answers[action].
function fakeServer(lists: List[], answers: Record<string, () => Response> = {}) {
  const gets: string[] = [];
  const posts: { url: string; body: unknown }[] = [];
  mockFetch(async (url, init) => {
    if (url.startsWith("/api/rejoin-requests?")) {
      gets.push(url);
      return jsonResponse(200, lists[Math.min(gets.length - 1, lists.length - 1)]);
    }
    if (url === "/api/structure") return jsonResponse(200, { buildings: [blockA] });
    const action = url.match(/^\/api\/rejoin-requests\/\d+\/(\w+)$/)?.[1];
    if (action && init?.method === "POST" && answers[action]) {
      posts.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      return answers[action]();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/rejoin-requests"]}>
      <RejoinRequestsPage />
    </MemoryRouter>,
  );
  return { user, gets, posts };
}

const card = (name: string) => screen.getByRole("listitem", { name });

describe("RejoinRequestsPage", () => {
  it("lists pending requests with who asked, when they left and their message", async () => {
    const { gets } = fakeServer([{ items: [ravi, meera], total: 2 }]);

    expect(await screen.findByRole("heading", { name: "Rejoin requests" })).toBeInTheDocument();
    const first = await screen.findByRole("listitem", { name: "Ravi Kumar" });
    expect(gets).toEqual(["/api/rejoin-requests?status=pending&page=1"]);
    expect(within(first).getByRole("link", { name: "Ravi Kumar" })).toHaveAttribute("href", "/students/7");
    expect(first).toHaveTextContent("ravi@example.com");
    expect(first).toHaveTextContent("Left on 30 Jun 2026 · asked on 2 Nov 2026");
    expect(first).toHaveTextContent("Back for my final year.");
    expect(card("Meera Joshi")).toHaveTextContent("No message.");
    expect(screen.getByText("2 waiting")).toBeInTheDocument();
  });

  it("shows decided requests on their own tab, with the outcome and who decided", async () => {
    const { user, gets } = fakeServer([
      { items: [ravi], total: 1 },
      { items: [decided], total: 1 },
    ]);
    await screen.findByRole("listitem", { name: "Ravi Kumar" });

    await user.click(screen.getByRole("button", { name: "Decided" }));

    const item = await screen.findByRole("listitem", { name: "Arjun Rao" });
    expect(gets[1]).toBe("/api/rejoin-requests?status=decided&page=1");
    expect(item).toHaveTextContent("Approved");
    expect(item).toHaveTextContent("Decided on 3 Nov 2026 by Test Owner");
    expect(within(item).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says when there is nothing waiting", async () => {
    fakeServer([{ items: [], total: 0 }]);
    expect(await screen.findByText("No requests are waiting.")).toBeInTheDocument();
  });

  it("asks before rejecting, and Cancel sends nothing", async () => {
    const { user, posts } = fakeServer([{ items: [ravi], total: 1 }], { reject: () => new Response(null, { status: 204 }) });
    await screen.findByRole("listitem", { name: "Ravi Kumar" });

    await user.click(within(card("Ravi Kumar")).getByRole("button", { name: "Reject" }));
    expect(screen.getByText("Reject the request from Ravi Kumar? Nothing else changes.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(posts).toEqual([]);
    expect(within(card("Ravi Kumar")).getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("rejects, says so and reloads the list", async () => {
    const { user, posts, gets } = fakeServer(
      [
        { items: [ravi], total: 1 },
        { items: [], total: 0 },
      ],
      { reject: () => new Response(null, { status: 204 }) },
    );
    await screen.findByRole("listitem", { name: "Ravi Kumar" });

    await user.click(within(card("Ravi Kumar")).getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Yes, reject" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Request from Ravi Kumar rejected.");
    expect(posts).toEqual([{ url: "/api/rejoin-requests/3/reject", body: undefined }]);
    expect(gets).toHaveLength(2);
    expect(await screen.findByText("No requests are waiting.")).toBeInTheDocument();
  });

  it("shows a refusal on rejecting, such as a request decided meanwhile", async () => {
    const { user } = fakeServer([{ items: [ravi], total: 1 }], {
      reject: () =>
        jsonResponse(409, { error: { code: "request_decided", message: "This request has already been approved." } }),
    });
    await screen.findByRole("listitem", { name: "Ravi Kumar" });
    await user.click(within(card("Ravi Kumar")).getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Yes, reject" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This request has already been approved.");
  });

  it("approves with a joining date and place, shows the temporary password once, and forgets it on Done", async () => {
    const admission = {
      student: { id: 7, name: "Ravi Kumar", email: "ravi@example.com", joiningDate: hostelToday(), buildingId: 1, roomId: null, bedId: null },
      temporaryPassword: "ABCD234567",
    };
    const { user, posts, gets } = fakeServer(
      [
        { items: [ravi], total: 1 },
        { items: [], total: 0 },
      ],
      { approve: () => jsonResponse(200, admission) },
    );
    await screen.findByRole("listitem", { name: "Ravi Kumar" });

    await user.click(within(card("Ravi Kumar")).getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("heading", { name: "Approve and reactivate" })).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("Building"), "Block A");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("ABCD234567")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request approved" })).toBeInTheDocument();
    expect(posts).toEqual([
      {
        url: "/api/rejoin-requests/3/approve",
        body: { joiningDate: hostelToday(), buildingId: 1, roomId: null, bedId: null },
      },
    ]);
    expect(gets).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("ABCD234567")).not.toBeInTheDocument();
  });

  it("pages through a long list", async () => {
    const { user, gets } = fakeServer([
      { items: [ravi], total: 45 },
      { items: [meera], total: 45 },
    ]);
    await screen.findByRole("listitem", { name: "Ravi Kumar" });
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByRole("listitem", { name: "Meera Joshi" });
    expect(gets[1]).toBe("/api/rejoin-requests?status=pending&page=2");
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { ComplaintStatus, OwnerComplaintDetail } from "../api/complaints";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ComplaintPage } from "./ComplaintPage";

const MOVES: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ["in_progress", "resolved", "rejected"],
  in_progress: ["resolved", "rejected"],
  resolved: ["open"],
  rejected: [],
};

const tap: OwnerComplaintDetail = {
  id: 1,
  category: "plumbing",
  description: "The tap in room 101 keeps dripping.\nIt wakes me up at night.",
  status: "open",
  priority: "normal",
  createdAt: "2026-11-04T03:30:00.000Z", // 9:00 am in India
  updatedAt: "2026-11-04T03:30:00.000Z",
  resolvedAt: null,
  student: { id: 7, name: "Asha Rao", isActive: true },
  place: { buildingName: "Block A", roomNumber: "101" },
  events: [{ kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: "2026-11-04T03:30:00.000Z" }],
  allowedMoves: MOVES.open,
};

const at = "2026-11-05T04:30:00.000Z"; // 10:00 am in India

type Call = { method: string; url: string; body: unknown };

// A fake server holding one complaint. Writes change it as the real one would, unless
// `refuse` answers instead.
function fakeServer(start: Partial<OwnerComplaintDetail> = {}, refuse?: (call: Call) => Response | undefined) {
  let complaint: OwnerComplaintDetail = { ...tap, ...start, allowedMoves: MOVES[start.status ?? tap.status] };
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const refusal = refuse?.(call);
    if (refusal) return refusal;
    if (!url.startsWith("/api/complaints/1")) {
      return jsonResponse(404, { error: { code: "complaint_not_found", message: "That complaint does not exist." } });
    }
    const body = call.body as Record<string, string | null>;
    if (call.method === "PATCH") complaint = { ...complaint, priority: body.priority as OwnerComplaintDetail["priority"] };
    if (url.endsWith("/status")) {
      const to = body.to as ComplaintStatus;
      complaint = {
        ...complaint,
        status: to,
        allowedMoves: MOVES[to],
        resolvedAt: to === "resolved" ? at : null,
        events: [...complaint.events, { kind: "status_change", note: body.note, fromStatus: complaint.status, toStatus: to, createdAt: at }],
      };
    }
    if (url.endsWith("/notes")) {
      complaint = {
        ...complaint,
        events: [...complaint.events, { kind: "note", note: body.note, fromStatus: null, toStatus: null, createdAt: at }],
      };
    }
    return jsonResponse(200, complaint);
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { calls, writes };
}

function renderAt(path = "/complaints/1") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/complaints/:id" element={<ComplaintPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

const timelineEntries = () =>
  within(screen.getByRole("region", { name: "Timeline" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("ComplaintPage", () => {
  it("shows the complaint, its priority, the student and where they live", async () => {
    fakeServer();
    renderAt();

    expect(await screen.findByRole("heading", { name: "Plumbing #1" })).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Plumbing #1" });
    expect(card).toHaveTextContent("Open");
    expect(card).toHaveTextContent("Normal priority");
    expect(card).toHaveTextContent("It wakes me up at night.");
    expect(card).toHaveTextContent("Raised 4 Nov 2026, 9:00 am");
    expect(card).toHaveTextContent("Asha Rao · Block A · Room 101");
    expect(within(card).getByRole("link", { name: "Asha Rao" })).toHaveAttribute("href", "/students/7");
    expect(screen.getByRole("link", { name: "← Complaints" })).toHaveAttribute("href", "/complaints");
    expect(timelineEntries()).toEqual(["Raised by the student4 Nov 2026, 9:00 am"]);
  });

  it("says when the student has moved out", async () => {
    fakeServer({ place: null, student: { id: 7, name: "Asha Rao", isActive: false } });
    renderAt();
    expect(await screen.findByRole("region", { name: "Plumbing #1" })).toHaveTextContent("Asha Rao · Moved out");
  });

  it.each([
    ["open", ["Start work", "Resolve", "Reject"]],
    ["in_progress", ["Resolve", "Reject"]],
    ["resolved", ["Reopen"]],
  ] as const)("offers exactly the server's moves for a complaint that is %s", async (status, buttons) => {
    fakeServer({ status });
    renderAt();
    const actions = await screen.findByRole("region", { name: "Work on it" });
    for (const name of ["Start work", "Resolve", "Reject", "Reopen"]) {
      if ((buttons as readonly string[]).includes(name)) {
        expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
      } else {
        expect(within(actions).queryByRole("button", { name })).not.toBeInTheDocument();
      }
    }
  });

  it("offers no move for a rejected complaint", async () => {
    fakeServer({ status: "rejected" });
    renderAt();
    expect(await screen.findByText("A rejected complaint is final.")).toBeInTheDocument();
    for (const name of ["Start work", "Resolve", "Reject", "Reopen"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("starts work with an optional note, sending the status it showed, and redraws", async () => {
    const server = fakeServer();
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: "Start work" }));
    const form = screen.getByLabelText(/Start work on this complaint/);
    await user.type(form, "  Plumber booked for Friday.  ");
    // Two "Start work" buttons now: the choice and the form's; the form's is the last.
    const send = screen.getAllByRole("button", { name: "Start work" }).at(-1)!;
    await user.click(send);

    expect(await screen.findByRole("status")).toHaveTextContent("Status changed to In progress.");
    expect(server.writes()).toEqual([
      {
        method: "POST",
        url: "/api/complaints/1/status",
        body: { from: "open", to: "in_progress", note: "Plumber booked for Friday." },
      },
    ]);
    expect(screen.getByRole("region", { name: "Plumbing #1" })).toHaveTextContent("In progress");
    expect(timelineEntries()).toContain("Moved from Open to In progressPlumber booked for Friday.5 Nov 2026, 10:00 am");
    // The form closes; the next moves come from the new status.
    expect(screen.queryByLabelText(/Start work on this complaint/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
  });

  it("resolves without a note, sending null", async () => {
    const server = fakeServer();
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: "Resolve" }));
    await user.click(screen.getAllByRole("button", { name: "Resolve" }).at(-1)!);
    expect(await screen.findByRole("status")).toHaveTextContent("Status changed to Resolved.");
    expect(server.writes()[0].body).toEqual({ from: "open", to: "resolved", note: null });
  });

  it.each([
    ["open", "Reject", /Reject this complaint/, "rejected"],
    ["resolved", "Reopen", /Reopen this complaint/, "open"],
  ] as const)("cannot %s→%s without a note", async (status, button, label, to) => {
    const server = fakeServer({ status });
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: button }));
    const send = () => screen.getAllByRole("button", { name: button }).at(-1)!;
    expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(send()).toBeDisabled();
    await user.type(screen.getByLabelText(label), "   ");
    expect(send()).toBeDisabled();

    await user.type(screen.getByLabelText(label), "Duplicate of #41.");
    expect(send()).toBeEnabled();
    await user.click(send());
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0].body).toEqual({ from: status, to, note: "Duplicate of #41." });
  });

  it("closes the move form on Cancel without sending anything", async () => {
    const server = fakeServer();
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Reject this complaint/)).not.toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });

  it("shows the server's message and a Reload button when the complaint changed meanwhile", async () => {
    const message = "This complaint has changed since you opened it. Reload it and try again.";
    let refused = false;
    const server = fakeServer({}, (call) => {
      if (call.url.endsWith("/status") && !refused) {
        refused = true;
        return jsonResponse(409, { error: { code: "status_changed", message } });
      }
      return undefined;
    });
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: "Resolve" }));
    await user.click(screen.getAllByRole("button", { name: "Resolve" }).at(-1)!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    const gets = server.calls.filter((c) => c.method === "GET").length;
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(server.calls.filter((c) => c.method === "GET").length).toBe(gets + 1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows any other refusal as the server words it, without a Reload button", async () => {
    const message = "The student already has an active plumbing complaint, so this one cannot be reopened.";
    fakeServer({ status: "resolved" }, (call) =>
      call.url.endsWith("/status") ? jsonResponse(409, { error: { code: "category_active", message } }) : undefined,
    );
    const user = renderAt();
    await user.click(await screen.findByRole("button", { name: "Reopen" }));
    await user.type(screen.getByLabelText(/Reopen this complaint/), "Still leaking.");
    await user.click(screen.getAllByRole("button", { name: "Reopen" }).at(-1)!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(within(alert).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    // The form stays open with the note, to try again.
    expect(screen.getByLabelText(/Reopen this complaint/)).toHaveValue("Still leaking.");
  });

  it("saves a new priority at once", async () => {
    const server = fakeServer();
    const user = renderAt();
    await user.selectOptions(await screen.findByLabelText(/Priority/), "high");

    expect(await screen.findByRole("status")).toHaveTextContent("High priority saved.");
    expect(server.writes()).toEqual([{ method: "PATCH", url: "/api/complaints/1", body: { priority: "high" } }]);
    expect(screen.getByRole("region", { name: "Plumbing #1" })).toHaveTextContent("High priority");
    expect(screen.getByLabelText(/Priority/)).toHaveValue("high");
  });

  it("adds a note: required, trimmed, shown in the timeline, and the box empties", async () => {
    const server = fakeServer();
    const user = renderAt();
    const box = await screen.findByLabelText(/Add a note/);
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();

    await user.type(box, " Router ordered. ");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Note added.");
    expect(server.writes()).toEqual([
      { method: "POST", url: "/api/complaints/1/notes", body: { note: "Router ordered." } },
    ]);
    expect(timelineEntries()).toContain("NoteRouter ordered.5 Nov 2026, 10:00 am");
    expect(box).toHaveValue("");
  });

  it("counts a note's characters as the server does, and refuses more than 500", async () => {
    fakeServer();
    const user = renderAt();
    const box = await screen.findByLabelText(/Add a note/);
    await user.click(box);
    await user.paste("🚿".repeat(500));
    expect(screen.getByText("500 / 500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add note" })).toBeEnabled();

    await user.paste("x");
    expect(screen.getByText("501 / 500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(box).toHaveAttribute("aria-invalid", "true");
  });

  it("shows the server's answer for a complaint that does not exist", async () => {
    fakeServer();
    renderAt("/complaints/99");
    expect(await screen.findByRole("alert")).toHaveTextContent("That complaint does not exist.");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

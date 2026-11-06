import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { StudentComplaintDetail } from "../api/complaints";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ComplaintDetailPage } from "./ComplaintDetailPage";

const NOT_FOUND = { error: { code: "complaint_not_found", message: "That complaint does not exist." } };

const tap: StudentComplaintDetail = {
  id: 42,
  category: "plumbing",
  description: "The tap in room 101 keeps dripping.\nIt wakes me up at night.",
  status: "resolved",
  createdAt: "2026-11-04T03:30:00.000Z", // 9:00 am in India
  updatedAt: "2026-11-05T06:30:00.000Z",
  resolvedAt: "2026-11-05T06:30:00.000Z", // 12:00 pm
  events: [
    { kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: "2026-11-04T03:30:00.000Z" },
    { kind: "status_change", note: null, fromStatus: "open", toStatus: "in_progress", createdAt: "2026-11-04T04:30:00.000Z" },
    { kind: "note", note: "Plumber booked for Friday.", fromStatus: null, toStatus: null, createdAt: "2026-11-04T05:30:00.000Z" },
    { kind: "status_change", note: null, fromStatus: "in_progress", toStatus: "resolved", createdAt: "2026-11-05T06:30:00.000Z" },
  ],
  photo: null,
};

// A fake server: GET /api/complaints/42 answers `tap` (or `answer`), any other id 404.
function renderAt(path: string, state?: unknown, answer: StudentComplaintDetail = tap) {
  const gets: string[] = [];
  mockFetch(async (url) => {
    gets.push(url);
    if (url === "/api/complaints/42") return jsonResponse(200, answer);
    return jsonResponse(404, NOT_FOUND);
  });
  render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/complaints/:id" element={<ComplaintDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { gets };
}

describe("ComplaintDetailPage", () => {
  it("shows the complaint with its status, times and text", async () => {
    const { gets } = renderAt("/complaints/42");

    expect(await screen.findByRole("heading", { name: "Plumbing" })).toBeInTheDocument();
    expect(gets).toEqual(["/api/complaints/42"]);
    const card = screen.getByRole("region", { name: "Plumbing" });
    expect(card).toHaveTextContent("Resolved");
    expect(card).toHaveTextContent("The tap in room 101 keeps dripping.");
    expect(card).toHaveTextContent("Raised 4 Nov 2026, 9:00 am · resolved 5 Nov 2026, 12:00 pm");
    expect(screen.getByRole("link", { name: "← My complaints" })).toHaveAttribute("href", "/");
  });

  it("lists the timeline in order, with the owner's note", async () => {
    renderAt("/complaints/42");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    const entries = within(timeline).getAllByRole("listitem");

    expect(entries.map((e) => e.textContent)).toEqual([
      "You raised this complaint4 Nov 2026, 9:00 am",
      "Status changed to In progress4 Nov 2026, 10:00 am",
      "Note from the ownerPlumber booked for Friday.4 Nov 2026, 11:00 am",
      "Status changed to Resolved5 Nov 2026, 12:00 pm",
    ]);
  });

  it("offers no way to reply, update or reopen", async () => {
    renderAt("/complaints/42");
    await screen.findByRole("heading", { name: "Plumbing" });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("confirms a complaint that was just sent", async () => {
    renderAt("/complaints/42", { created: true });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your complaint has been sent. The owner will see it on the dashboard.",
    );
  });

  it("shows no confirmation when opened from the list", async () => {
    renderAt("/complaints/42");
    await screen.findByRole("heading", { name: "Plumbing" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the server's answer for a complaint that does not exist or is not yours", async () => {
    renderAt("/complaints/7");
    expect(await screen.findByRole("alert")).toHaveTextContent("That complaint does not exist.");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("shows the student's own photo, with no countdown (day 8)", async () => {
    const url = "https://storage.test/object/sign/complaints/a.jpg?token=x";
    renderAt("/complaints/42", undefined, { ...tap, photo: { status: "available", url } });
    const photo = await screen.findByRole("region", { name: "Photo" });
    expect(within(photo).getByRole("img", { name: "Photo sent with the complaint" })).toHaveAttribute("src", url);
    expect(photo).not.toHaveTextContent(/Deleted in/);
  });

  it("says when the photo has been deleted", async () => {
    renderAt("/complaints/42", undefined, { ...tap, photo: { status: "expired" } });
    expect(await screen.findByText("The photo has been deleted. Photos are kept for 48 hours.")).toBeInTheDocument();
  });
});

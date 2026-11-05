import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComplaintEvent } from "../api/complaints";
import { ComplaintTimeline } from "./ComplaintTimeline";

const events: ComplaintEvent[] = [
  { kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: "2026-11-04T03:30:00.000Z" },
  { kind: "status_change", note: null, fromStatus: "open", toStatus: "in_progress", createdAt: "2026-11-04T04:30:00.000Z" },
  { kind: "note", note: "Plumber booked.\nComes on Friday.", fromStatus: null, toStatus: null, createdAt: "2026-11-04T05:30:00.000Z" },
  { kind: "status_change", note: "Duplicate of #41.", fromStatus: "in_progress", toStatus: "rejected", createdAt: "2026-11-05T06:30:00.000Z" },
];

const entries = () => within(screen.getByRole("region", { name: "Timeline" })).getAllByRole("listitem");

describe("ComplaintTimeline", () => {
  it("speaks to the student about 'you' and 'the owner'", () => {
    render(<ComplaintTimeline events={events} viewer="student" />);
    expect(entries().map((e) => e.textContent)).toEqual([
      "You raised this complaint4 Nov 2026, 9:00 am",
      "Status changed to In progress4 Nov 2026, 10:00 am",
      "Note from the ownerPlumber booked.\nComes on Friday.4 Nov 2026, 11:00 am",
      "Status changed to RejectedDuplicate of #41.5 Nov 2026, 12:00 pm",
    ]);
  });

  it("shows the owner each move from and to", () => {
    render(<ComplaintTimeline events={events} viewer="owner" />);
    expect(entries().map((e) => e.textContent)).toEqual([
      "Raised by the student4 Nov 2026, 9:00 am",
      "Moved from Open to In progress4 Nov 2026, 10:00 am",
      "NotePlumber booked.\nComes on Friday.4 Nov 2026, 11:00 am",
      "Moved from In progress to RejectedDuplicate of #41.5 Nov 2026, 12:00 pm",
    ]);
  });

  it("keeps the note's line breaks", () => {
    render(<ComplaintTimeline events={events} viewer="owner" />);
    expect(screen.getByText(/Plumber booked\./)).toHaveClass("whitespace-pre-line");
  });

  it("says so when there is nothing yet", () => {
    render(<ComplaintTimeline events={[]} viewer="owner" />);
    expect(screen.getByRole("region", { name: "Timeline" })).toHaveTextContent("Nothing yet.");
  });
});

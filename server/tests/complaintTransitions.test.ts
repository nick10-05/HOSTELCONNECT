import { describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { checkStatusChange, OWNER_NOTE_MAX, STATUS_MOVES, type ComplaintStatus } from "../src/services/complaints";

// The status moves decided on day 7 (section 4): five forward moves and one reopen.
// Pure function, no database.

const STATUSES: ComplaintStatus[] = ["open", "in_progress", "resolved", "rejected"];

const LEGAL: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ["in_progress", "resolved", "rejected"],
  in_progress: ["resolved", "rejected"],
  resolved: ["open"],
  rejected: [],
};

// Every one of the 16 pairs, each with a note so that the note rules never decide.
const PAIRS = STATUSES.flatMap((from) =>
  STATUSES.map((to) => ({ from, to, legal: LEGAL[from].includes(to) })),
);

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected a refusal, but the move was allowed");
}

function expectRefused(call: () => unknown, status: number, code: string): string {
  const err = refusal(call);
  expect({ status: err.status, code: err.code }).toEqual({ status, code });
  return err.message;
}

describe("checkStatusChange: which moves are legal", () => {
  it("checks all 16 pairs", () => {
    expect(PAIRS).toHaveLength(16);
    expect(PAIRS.filter((p) => p.legal)).toHaveLength(6);
  });

  it.each(PAIRS)("$from -> $to: legal = $legal", ({ from, to, legal }) => {
    const call = () => checkStatusChange(from, to, "Checked by the owner.");
    if (legal) {
      expect(call()).toBe("Checked by the owner.");
    } else {
      expectRefused(call, 409, "illegal_transition");
    }
  });

  it("names both statuses as the owner reads them", () => {
    expect(expectRefused(() => checkStatusChange("resolved", "in_progress", "x"), 409, "illegal_transition")).toBe(
      "A complaint that is resolved cannot be moved to in progress.",
    );
    expect(expectRefused(() => checkStatusChange("in_progress", "in_progress", "x"), 409, "illegal_transition")).toBe(
      "A complaint that is in progress cannot be moved to in progress.",
    );
    expect(expectRefused(() => checkStatusChange("rejected", "open", "x"), 409, "illegal_transition")).toBe(
      "A complaint that is rejected cannot be moved to open.",
    );
  });

  it("refuses an illegal move before looking at the note", () => {
    // Rejected cannot be reopened: the answer is 409, not "needs a note".
    expectRefused(() => checkStatusChange("rejected", "open", null), 409, "illegal_transition");
    expectRefused(() => checkStatusChange("rejected", "rejected", ""), 409, "illegal_transition");
    expectRefused(() => checkStatusChange("open", "open", "x".repeat(OWNER_NOTE_MAX + 1)), 409, "illegal_transition");
  });
});

describe("STATUS_MOVES", () => {
  it.each(STATUSES)("lists exactly the legal moves from %s", (from) => {
    expect([...STATUS_MOVES[from]].sort()).toEqual([...LEGAL[from]].sort());
  });
});

describe("checkStatusChange: notes", () => {
  const MISSING = [undefined, null, "", "   ", " \t\n\r\n "];

  it.each([
    { from: "open", to: "rejected", message: "Rejecting a complaint needs a note." },
    { from: "in_progress", to: "rejected", message: "Rejecting a complaint needs a note." },
    { from: "resolved", to: "open", message: "Reopening a complaint needs a note." },
  ] as const)("$from -> $to needs a note", ({ from, to, message }) => {
    for (const note of MISSING) {
      expect(expectRefused(() => checkStatusChange(from, to, note), 400, "note_required"), JSON.stringify(note)).toBe(
        message,
      );
    }
  });

  it.each([
    { from: "open", to: "in_progress" },
    { from: "open", to: "resolved" },
    { from: "in_progress", to: "resolved" },
  ] as const)("$from -> $to works without a note (null back)", ({ from, to }) => {
    for (const note of MISSING) {
      expect(checkStatusChange(from, to, note), JSON.stringify(note)).toBeNull();
    }
  });

  it("returns the note trimmed", () => {
    expect(checkStatusChange("open", "rejected", "  Duplicate of #41.\n")).toBe("Duplicate of #41.");
    expect(checkStatusChange("open", "in_progress", "\tPlumber comes at 4.  ")).toBe("Plumber comes at 4.");
    // Line breaks inside the note stay.
    expect(checkStatusChange("resolved", "open", " Still leaking.\nChecked again. ")).toBe(
      "Still leaking.\nChecked again.",
    );
  });

  it(`allows ${OWNER_NOTE_MAX} characters and refuses one more`, () => {
    expect(OWNER_NOTE_MAX).toBe(500);
    const longest = "a".repeat(OWNER_NOTE_MAX);
    expect(checkStatusChange("open", "rejected", longest)).toBe(longest);
    expect(expectRefused(() => checkStatusChange("open", "rejected", longest + "a"), 400, "note_too_long")).toBe(
      "A note can be at most 500 characters.",
    );
    // An optional note is limited too.
    expectRefused(() => checkStatusChange("open", "resolved", longest + "a"), 400, "note_too_long");
  });

  it("counts characters as the database does: an emoji is one", () => {
    // 500 emoji are 1000 UTF-16 units but 500 characters.
    const emoji = "🚿".repeat(OWNER_NOTE_MAX);
    expect(emoji.length).toBe(1000);
    expect(checkStatusChange("resolved", "open", emoji)).toBe(emoji);
    expectRefused(() => checkStatusChange("resolved", "open", emoji + "🚿"), 400, "note_too_long");
  });

  it("counts the length after trimming", () => {
    const longest = "a".repeat(OWNER_NOTE_MAX);
    expect(checkStatusChange("open", "rejected", `   ${longest}\n\n`)).toBe(longest);
  });
});

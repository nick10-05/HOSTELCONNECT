import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComplaintPhoto, timeLeftText } from "./ComplaintPhoto";

// The photo on both detail pages (day 8). The owner sees a countdown to its deletion; the
// student does not (decided on day 8).
const NOW = new Date("2026-11-06T06:00:00Z").getTime();
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const URL = "https://storage.test/object/sign/complaints/a.jpg?token=x";

describe("timeLeftText", () => {
  it("says hours and minutes, then minutes, then under a minute", () => {
    expect(timeLeftText(at(47 * HOUR + 59 * MIN + 30_000), NOW)).toBe("47 h 59 min");
    expect(timeLeftText(at(5 * HOUR), NOW)).toBe("5 h 0 min");
    expect(timeLeftText(at(59 * MIN + 59_000), NOW)).toBe("59 min");
    expect(timeLeftText(at(MIN), NOW)).toBe("1 min");
    expect(timeLeftText(at(59_000), NOW)).toBe("under a minute");
  });

  it("is null once the time is up", () => {
    expect(timeLeftText(at(0), NOW)).toBeNull();
    expect(timeLeftText(at(-HOUR), NOW)).toBeNull();
  });
});

describe("ComplaintPhoto", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("shows nothing for a complaint without a photo", () => {
    const { container } = render(<ComplaintPhoto photo={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the student their photo, with no countdown", () => {
    render(<ComplaintPhoto photo={{ status: "available", url: URL }} />);
    expect(screen.getByRole("img", { name: "Photo sent with the complaint" })).toHaveAttribute("src", URL);
    expect(screen.queryByText(/Deleted in/)).not.toBeInTheDocument();
  });

  it("shows the owner the photo and counts down to its deletion", () => {
    render(<ComplaintPhoto photo={{ status: "available", url: URL, expiresAt: at(2 * HOUR + MIN) }} countdown />);
    expect(screen.getByRole("img", { name: "Photo sent with the complaint" })).toBeInTheDocument();
    expect(screen.getByText("Deleted in 2 h 1 min")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2 * MIN));
    expect(screen.getByText("Deleted in 1 h 59 min")).toBeInTheDocument();
  });

  it("hides the photo and says it is deleted once the countdown reaches zero", () => {
    render(<ComplaintPhoto photo={{ status: "available", url: URL, expiresAt: at(40_000) }} countdown />);
    expect(screen.getByText("Deleted in under a minute")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("The photo has been deleted. Photos are kept for 48 hours.")).toBeInTheDocument();
  });

  it("says when the photo is already deleted, for both", () => {
    const { rerender } = render(<ComplaintPhoto photo={{ status: "expired" }} />);
    expect(screen.getByText("The photo has been deleted. Photos are kept for 48 hours.")).toBeInTheDocument();
    rerender(<ComplaintPhoto photo={{ status: "expired", expiresAt: at(-HOUR) }} countdown />);
    expect(screen.getByText("The photo has been deleted. Photos are kept for 48 hours.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("says the photo cannot be shown now, keeping the owner's countdown", () => {
    render(<ComplaintPhoto photo={{ status: "unavailable", expiresAt: at(3 * HOUR) }} countdown />);
    expect(screen.getByText("The photo cannot be shown right now. Try again later.")).toBeInTheDocument();
    expect(screen.getByText("Deleted in 3 h 0 min")).toBeInTheDocument();
  });

  it("explains a link that has run out instead of showing a broken picture", () => {
    render(<ComplaintPhoto photo={{ status: "available", url: URL }} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("The photo link has run out. Reload the page to see it again.")).toBeInTheDocument();
  });
});

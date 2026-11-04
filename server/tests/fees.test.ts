import { describe, expect, it } from "vitest";
import { nextDueDate, nthDueDate } from "../src/services/fees";

// The due-date rule in src/services/fees.ts (you write it): joining date plus n months,
// day clamped to the month's last day, always counted from the joining date.

// The first `count` due dates for one joining date.
const dueDates = (joined: string, count: number) =>
  Array.from({ length: count }, (_, i) => nthDueDate(joined, i + 1));

describe("nthDueDate", () => {
  it("keeps the joining day when every month has it (the design's Jan 14 example)", () => {
    expect(dueDates("2026-01-14", 3)).toEqual(["2026-02-14", "2026-03-14", "2026-04-14"]);
  });

  it("clamps the 31st to short months and returns to the 31st after", () => {
    expect(dueDates("2026-01-31", 6)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
    ]);
  });

  it("uses 29 February in a leap year", () => {
    expect(nthDueDate("2028-01-31", 1)).toBe("2028-02-29");
    expect(nthDueDate("2028-01-30", 1)).toBe("2028-02-29");
    expect(nthDueDate("2028-01-29", 1)).toBe("2028-02-29");
  });

  it("clamps the 29th and 30th of January to 28 February outside a leap year", () => {
    expect(nthDueDate("2026-01-29", 1)).toBe("2026-02-28");
    expect(nthDueDate("2026-01-30", 1)).toBe("2026-02-28");
    expect(nthDueDate("2026-01-28", 1)).toBe("2026-02-28");
  });

  it("follows the century rule: 2100 is not a leap year, 2000 was", () => {
    expect(nthDueDate("2100-01-31", 1)).toBe("2100-02-28");
    expect(nthDueDate("2000-01-31", 1)).toBe("2000-02-29");
  });

  it("handles a student who joined on 29 February", () => {
    // 2028 is a leap year; 2029 is not.
    expect(dueDates("2028-02-29", 2)).toEqual(["2028-03-29", "2028-04-29"]);
    expect(nthDueDate("2028-02-29", 12)).toBe("2029-02-28");
    expect(nthDueDate("2028-02-29", 48)).toBe("2032-02-29");
  });

  it("clamps the 31st to 30-day months", () => {
    expect(nthDueDate("2026-03-31", 1)).toBe("2026-04-30");
    expect(nthDueDate("2026-08-31", 1)).toBe("2026-09-30");
    expect(nthDueDate("2026-10-31", 1)).toBe("2026-11-30");
  });

  it("crosses the year end", () => {
    expect(dueDates("2026-11-15", 3)).toEqual(["2026-12-15", "2027-01-15", "2027-02-15"]);
    expect(nthDueDate("2026-12-31", 2)).toBe("2027-02-28");
  });

  it("never drifts: a 31st-of-the-month student is due on the 31st a year and more later", () => {
    expect(nthDueDate("2026-01-31", 12)).toBe("2027-01-31");
    expect(nthDueDate("2026-01-31", 24)).toBe("2028-01-31");
    expect(nthDueDate("2026-01-31", 100)).toBe("2034-05-31");
    // 2026-08-31 + 18 months = February 2028, a leap year.
    expect(nthDueDate("2026-08-31", 18)).toBe("2028-02-29");
  });

  it("counts every due date from the joining date, not from the previous one", () => {
    // Chaining would give Feb 28 -> Mar 28 -> Apr 28; the rule gives Mar 31 and Apr 30.
    const chained = nthDueDate(nthDueDate("2026-01-31", 1), 1);
    expect(chained).toBe("2026-03-28");
    expect(nthDueDate("2026-01-31", 2)).toBe("2026-03-31");
  });

  it("does not depend on the server's time zone", () => {
    // Going through a local-time Date can shift the day by one. These are the dates most
    // likely to slip; the tests run in India time locally and in UTC on CI, so both count.
    expect(nthDueDate("2026-03-01", 1)).toBe("2026-04-01");
    expect(nthDueDate("2026-12-01", 1)).toBe("2027-01-01");
  });

  it("refuses an n that is not a whole number from 1 up", () => {
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => nthDueDate("2026-01-14", n)).toThrow(RangeError);
    }
  });
});

// The profile's "next due date": the first due date on or after today.
describe("nextDueDate", () => {
  it("is the next due date after today", () => {
    expect(nextDueDate("2026-01-14", "2026-11-04")).toBe("2026-11-14");
    expect(nextDueDate("2026-01-14", "2026-11-15")).toBe("2026-12-14");
  });

  it("is today when a due date falls today", () => {
    expect(nextDueDate("2026-01-14", "2026-11-14")).toBe("2026-11-14");
  });

  it("follows the month-end rule", () => {
    expect(nextDueDate("2026-01-31", "2026-11-04")).toBe("2026-11-30");
    expect(nextDueDate("2026-01-31", "2027-02-01")).toBe("2027-02-28");
  });

  it("is one month after joining for a student who joined today or has not arrived yet", () => {
    expect(nextDueDate("2026-11-04", "2026-11-04")).toBe("2026-12-04");
    expect(nextDueDate("2026-11-20", "2026-11-04")).toBe("2026-12-20");
  });

  it("works for a joining date years back", () => {
    expect(nextDueDate("2019-07-31", "2026-11-04")).toBe("2026-11-30");
  });
});

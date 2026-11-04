import { describe, expect, it } from "vitest";
import { addDays, hostelToday } from "../src/lib/dates";

describe("hostelToday", () => {
  it("is India's date, not the server's", () => {
    // 20:00 UTC on 31 Jan is already 01:30 on 1 Feb in India.
    expect(hostelToday(new Date("2026-01-31T20:00:00Z"))).toBe("2026-02-01");
    // 18:00 UTC is 23:30 in India: still the same day.
    expect(hostelToday(new Date("2026-01-31T18:00:00Z"))).toBe("2026-01-31");
  });
});

describe("addDays", () => {
  it("crosses month and year ends and leap days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-04", 30)).toBe("2026-12-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

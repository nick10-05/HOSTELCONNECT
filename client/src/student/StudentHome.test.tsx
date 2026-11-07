import { describe, expect, it } from "vitest";
import { greeting } from "./StudentHome";

describe("greeting", () => {
  // India is UTC+5:30.
  const at = (utc: string) => new Date(`2026-11-07T${utc}Z`);

  it("says good morning, afternoon or evening by India's clock", () => {
    expect(greeting(at("00:30:00"))).toBe("Good morning"); // 6:00 am
    expect(greeting(at("06:29:00"))).toBe("Good morning"); // 11:59 am
    expect(greeting(at("06:30:00"))).toBe("Good afternoon"); // 12:00 pm
    expect(greeting(at("11:29:00"))).toBe("Good afternoon"); // 4:59 pm
    expect(greeting(at("11:30:00"))).toBe("Good evening"); // 5:00 pm
    expect(greeting(at("18:00:00"))).toBe("Good evening"); // 11:30 pm
  });
});

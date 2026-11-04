import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEMP_PASSWORD_ALPHABET,
  TEMP_PASSWORD_LENGTH,
  generateTemporaryPassword,
} from "../src/lib/tempPassword";

describe("temporary password alphabet", () => {
  it("leaves out characters that look alike when read or written", () => {
    for (const c of ["0", "O", "o", "1", "I", "l", "i"]) {
      expect(TEMP_PASSWORD_ALPHABET).not.toContain(c);
    }
  });

  it("has 32 distinct characters", () => {
    expect(TEMP_PASSWORD_ALPHABET).toHaveLength(32);
    expect(new Set(TEMP_PASSWORD_ALPHABET).size).toBe(32);
  });

  it("is 10 characters long, the length decided on day 4", () => {
    expect(TEMP_PASSWORD_LENGTH).toBe(10);
  });
});

describe("generateTemporaryPassword", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 10 characters, all from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(TEMP_PASSWORD_LENGTH);
      for (const c of password) expect(TEMP_PASSWORD_ALPHABET).toContain(c);
    }
  });

  it("gives a different password each time", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(1000);
  });

  // 2,000 passwords = 20,000 characters, about 625 of each. A character that never
  // appears or appears far too often points to an off-by-one or a biased pick.
  // The range below is more than 9 standard deviations wide, so it never fails by luck.
  it("uses every character of the alphabet about equally often", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const c of generateTemporaryPassword()) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const c of TEMP_PASSWORD_ALPHABET) {
      expect(counts.get(c) ?? 0).toBeGreaterThan(400);
      expect(counts.get(c) ?? 0).toBeLessThan(850);
    }
  });

  // Math.random is predictable; passwords must come from node:crypto.
  it("does not use Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    generateTemporaryPassword();
    expect(spy).not.toHaveBeenCalled();
  });
});

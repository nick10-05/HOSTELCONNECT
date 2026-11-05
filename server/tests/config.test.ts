import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  JWT_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("accepts valid settings and applies defaults", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
  });

  it("turns PORT into a number", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({ JWT_SECRET: valid.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("names a malformed DATABASE_URL without printing it", () => {
    const password = "Pw#secret";
    let message = "";
    try {
      loadConfig({ ...valid, DATABASE_URL: `postgres://user:${password}@localhost:5432/db` });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL: is not a valid URL/);
    expect(message).not.toContain(password);
  });

  it("rejects a short JWT_SECRET without printing it", () => {
    const secret = "too-short-secret";
    let message = "";
    try {
      loadConfig({ ...valid, JWT_SECRET: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).not.toContain(secret);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...valid, PORT: "99999" })).toThrow(/PORT/);
  });

  it("has the design's complaint limits by default, and takes others", () => {
    const config = loadConfig(valid);
    expect(config.COMPLAINT_MAX_ACTIVE).toBe(3);
    expect(config.COMPLAINT_MAX_NEW_PER_DAY).toBe(2);

    const changed = loadConfig({ ...valid, COMPLAINT_MAX_ACTIVE: "5", COMPLAINT_MAX_NEW_PER_DAY: "4" });
    expect(changed.COMPLAINT_MAX_ACTIVE).toBe(5);
    expect(changed.COMPLAINT_MAX_NEW_PER_DAY).toBe(4);
  });

  it("rejects a complaint limit below 1 or not a whole number", () => {
    for (const value of ["0", "-1", "2.5", "many"]) {
      expect(() => loadConfig({ ...valid, COMPLAINT_MAX_ACTIVE: value }), value).toThrow(/COMPLAINT_MAX_ACTIVE/);
      expect(() => loadConfig({ ...valid, COMPLAINT_MAX_NEW_PER_DAY: value }), value).toThrow(
        /COMPLAINT_MAX_NEW_PER_DAY/,
      );
    }
  });
});

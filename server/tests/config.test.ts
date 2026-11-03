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
});

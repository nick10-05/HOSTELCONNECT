import { format } from "node:util";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler";

afterEach(() => {
  vi.restoreAllMocks();
});

// What console.error would have printed: Node formats each call with util.format,
// which, unlike String(), includes an error's extra fields such as `detail`.
const printed = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map((args) => format(...args)).join("\n");

// An app whose only route throws the given value.
function throwing(value: unknown) {
  const app = express();
  app.get("/boom", () => {
    throw value;
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("answers 500 in the API error shape without leaking the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(throwing(new Error("secret internals"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal", message: "Something went wrong" } });
  });

  it("logs a database error without the values quoted in its detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Shaped like a pg unique-violation error.
    const dbError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_lower_key"'),
      { code: "23505", detail: "Key (lower(email))=(asha@example.com) already exists." },
    );
    await request(throwing(dbError)).get("/boom");

    expect(printed(log)).toContain("users_email_lower_key");
    expect(printed(log)).not.toContain("asha@example.com");
  });

  it("does not print a thrown non-Error value", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(throwing({ phone: "9000000000" })).get("/boom");
    expect(printed(log)).not.toContain("9000000000");
  });
});

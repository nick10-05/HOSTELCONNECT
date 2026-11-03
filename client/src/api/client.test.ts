import { describe, expect, it } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ApiError, apiFetch } from "./client";

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("apiFetch", () => {
  it("sends JSON with the same-origin cookie and returns the parsed body", async () => {
    const fetch = mockFetch(async () => jsonResponse(200, { ok: true }));
    expect(await apiFetch("/api/x", { method: "POST", body: { a: 1 } })).toEqual({ ok: true });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/x");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("turns the server's error envelope into an ApiError", async () => {
    mockFetch(async () =>
      jsonResponse(429, { error: { code: "rate_limited", message: "Too many attempts" } }),
    );
    const err = await caught(apiFetch("/api/x"));
    expect(err).toMatchObject({ status: 429, code: "rate_limited", message: "Too many attempts" });
  });

  it("copes with an error that has no JSON body", async () => {
    mockFetch(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = await caught(apiFetch("/api/x"));
    expect(err).toMatchObject({ status: 502, code: "http_502" });
  });

  it("reports an unreachable server as status 0", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await caught(apiFetch("/api/x"));
    expect(err).toMatchObject({ status: 0, code: "network" });
  });
});

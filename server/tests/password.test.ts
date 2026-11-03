import { describe, expect, it } from "vitest";
import { BCRYPT_COST, hashPassword, verifyPassword } from "../src/lib/password";

// Cost 12 is deliberately slow (a few hundred ms per hash in pure JavaScript).
describe("password hashing", { timeout: 20_000 }, () => {
  it("uses cost 12", () => {
    expect(BCRYPT_COST).toBe(12);
  });

  it("produces a bcrypt hash at that cost, never the password itself", async () => {
    const hash = await hashPassword("Correct-Horse-7");
    expect(hash).not.toContain("Correct-Horse-7");
    // $2a$ or $2b$ = bcrypt, then the cost.
    expect(hash).toMatch(/^\$2[ab]\$12\$/);
  });

  it("salts every hash, so the same password hashes differently each time", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(a).not.toBe(b);
  });

  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("Correct-Horse-7");
    expect(await verifyPassword("Correct-Horse-7", hash)).toBe(true);
    expect(await verifyPassword("correct-horse-7", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("returns false instead of throwing for a malformed hash", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

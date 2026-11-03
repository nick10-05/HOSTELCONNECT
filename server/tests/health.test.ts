import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createPool } from "../src/db";
import { testPool } from "./helpers/db";

describe("GET /api/health", () => {
  const db = testPool();
  // Nothing listens on port 1, so every query fails the way an unreachable database does.
  const deadDb = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
  afterAll(async () => {
    await db.end();
    await deadDb.end();
  });

  it("answers 200 when the database responds", async () => {
    const res = await request(createApp({ db })).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("answers 503 without leaking connection details when the database is down", async () => {
    const res = await request(createApp({ db: deadDb })).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("db_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");
  });
});

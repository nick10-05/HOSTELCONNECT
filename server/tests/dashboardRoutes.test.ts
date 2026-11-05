import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// GET /api/dashboard through the real app and database. The numbers themselves are
// tests/dashboard.test.ts's job; here: who may ask, the answer's shape, and no caching.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

const app = createApp({ db, jwtSecret: SECRET });
const cookieFor = (userId: number, role: "owner" | "student") =>
  `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

describe("GET /api/dashboard", () => {
  it("is for the owner only", async () => {
    expect((await request(app).get("/api/dashboard")).status).toBe(401);
    const student = await insertStudent(db);
    expect((await request(app).get("/api/dashboard").set("Cookie", cookieFor(student, "student"))).status).toBe(403);
  });

  it("answers the students, rejoin requests and complaints cards, never cached", async () => {
    const owner = await insertOwner(db);
    const res = await request(app).get("/api/dashboard").set("Cookie", cookieFor(owner, "owner"));

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      students: { total: expect.any(Number), joiningLater: expect.any(Number), buildings: expect.any(Array) },
      rejoinRequests: { pending: expect.any(Number), oldestRequestedOn: expect.toBeOneOf([null, expect.any(String)]) },
      complaints: {
        active: expect.any(Number),
        highPriority: expect.any(Number),
        oldestActiveAt: expect.toBeOneOf([null, expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)]),
      },
    });
  });
});

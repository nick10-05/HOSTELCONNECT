import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStructure, testPool } from "./helpers/db";

// Day 4 "done when", end to end through the real app and database, nothing mocked:
// the owner admits a student, the student logs in with the temporary password, is held
// at the change-password gate, changes it, and is then let through.
const SECRET = "test-secret-that-is-at-least-32-characters";
const OWNER_PASSWORD = "Owner-Password-9";
const db = testPool();
const app = createApp({ db, jwtSecret: SECRET });
let ownerEmail: string;

beforeAll(async () => {
  const id = await insertOwner(db, { passwordHash: await hashPassword(OWNER_PASSWORD) });
  ownerEmail = (await db.query("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
});
afterAll(() => db.end());

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ hostel: "sns-hostel", email, password });
  expect(res.status).toBe(200);
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0];
}

describe("admission to first login", { timeout: 60_000 }, () => {
  it("admits a student who must change the temporary password before anything else", async () => {
    const s = await insertStructure(db);
    const email = `new-${randomUUID()}@test.local`;
    const owner = await login(ownerEmail, OWNER_PASSWORD);

    const admitted = await request(app)
      .post("/api/students")
      .set("Cookie", owner)
      .send({
        name: "Ravi Kumar",
        email,
        phone: "9123456780",
        parentPhone: "9123456781",
        category: "other",
        joiningDate: "2026-11-01",
        foodPreference: "non_veg",
        buildingId: s.building,
      });
    expect(admitted.status).toBe(201);
    const temporaryPassword: string = admitted.body.temporaryPassword;

    // The student logs in with the temporary password...
    const student = await login(email, temporaryPassword);
    const me = await request(app).get("/api/auth/me").set("Cookie", student);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ role: "student", mustChangePassword: true });

    // ...and is held at the gate everywhere else.
    const blocked = await request(app).get("/api/structure").set("Cookie", student);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("password_change_required");

    // After changing it, the gate opens: the next refusal is about the role, not the password.
    const changed = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", student)
      .send({ currentPassword: temporaryPassword, newPassword: "My-Own-Password-1" });
    expect(changed.status).toBe(200);

    const after = await request(app).get("/api/structure").set("Cookie", student);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe("forbidden");

    // The temporary password no longer works.
    const old = await request(app).post("/api/auth/login").send({ hostel: "sns-hostel", email, password: temporaryPassword });
    expect(old.status).toBe(401);
  });
});

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStructure, testPool } from "./helpers/db";

// A student's password reset, end to end through the real app and database, nothing
// mocked: the owner resets it, the old password stops working at once, a session already
// open is held at the change-password screen, and the temporary password must be changed
// before anything else works.
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
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0];
}

const loginStatus = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).status;

describe("a student's password reset", { timeout: 60_000 }, () => {
  it("replaces the password at once, and the new one must be changed first", async () => {
    const s = await insertStructure(db);
    const email = `forgetful-${randomUUID()}@test.local`;
    const owner = await login(ownerEmail, OWNER_PASSWORD);

    // Admitted, logged in, own password chosen.
    const admitted = await request(app)
      .post("/api/students")
      .set("Cookie", owner)
      .send({
        name: "Ravi Kumar",
        email,
        phone: "9123456784",
        parentPhone: "9123456785",
        category: "other",
        joiningDate: "2026-01-14",
        foodPreference: "veg",
        buildingId: s.building,
        roomId: s.room,
        bedId: s.bed1,
      });
    expect(admitted.status).toBe(201);
    const id: number = admitted.body.student.id;
    const session = await login(email, admitted.body.temporaryPassword);
    await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", session)
      .send({ currentPassword: admitted.body.temporaryPassword, newPassword: "Ravi-Own-Password-1" })
      .expect(200);
    await request(app).get("/api/notifications").set("Cookie", session).expect(200);

    // The owner resets it.
    const reset = await request(app).post(`/api/students/${id}/reset-password`).set("Cookie", owner);
    expect(reset.status).toBe(200);
    expect(reset.headers["cache-control"]).toBe("no-store");
    const temporary: string = reset.body.temporaryPassword;

    // The old password is gone; the open session is held until the password is changed.
    expect(await loginStatus(email, "Ravi-Own-Password-1")).toBe(401);
    const held = await request(app).get("/api/notifications").set("Cookie", session);
    expect(held.status).toBe(403);
    expect(held.body.error.code).toBe("password_change_required");

    // The temporary password logs in, must be changed, and then everything works again.
    const fresh = await login(email, temporary);
    expect((await request(app).get("/api/notifications").set("Cookie", fresh)).status).toBe(403);
    await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", fresh)
      .send({ currentPassword: temporary, newPassword: "Ravi-New-Password-2" })
      .expect(200);
    await request(app).get("/api/notifications").set("Cookie", fresh).expect(200);
    expect(await loginStatus(email, temporary)).toBe(401);
    expect(await loginStatus(email, "Ravi-New-Password-2")).toBe(200);

    // Nothing else changed: still an active student in the same bed.
    const profile = await request(app).get(`/api/students/${id}`).set("Cookie", owner).expect(200);
    expect(profile.body.student).toMatchObject({ isActive: true });
    expect(profile.body.student.stays).toHaveLength(1);
    expect(profile.body.student.stays[0]).toMatchObject({ bedId: s.bed1, endedOn: null });
  });
});

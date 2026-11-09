import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hostelToday } from "../src/lib/dates";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStructure, testPool } from "./helpers/db";

// Day 5 "deactivate and reactivate work", end to end through the real app and database,
// nothing mocked: a student who moves out is locked out at once, even with a session
// already open; when they come back, only the new temporary password works, and it must
// be changed first.
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

const loginStatus = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ hostel: "sns-hostel", email, password })).status;

describe("moving out and coming back", { timeout: 60_000 }, () => {
  it("locks a student out at once, and lets them back only with a new temporary password", async () => {
    const s = await insertStructure(db);
    const email = `leaver-${randomUUID()}@test.local`;
    const owner = await login(ownerEmail, OWNER_PASSWORD);

    // Admitted, logged in, own password chosen.
    const admitted = await request(app)
      .post("/api/students")
      .set("Cookie", owner)
      .send({
        name: "Meera Joshi",
        email,
        phone: "9123456782",
        parentPhone: "9123456783",
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
      .send({ currentPassword: admitted.body.temporaryPassword, newPassword: "Meera-Own-Password-1" })
      .expect(200);
    await request(app).get("/api/auth/me").set("Cookie", session).expect(200);

    // Moved out: the open session stops working and logging in again fails.
    await request(app).post(`/api/students/${id}/deactivate`).set("Cookie", owner).expect(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", session)).status).toBe(401);
    expect(await loginStatus(email, "Meera-Own-Password-1")).toBe(401);

    const former = await request(app).get(`/api/students/${id}`).set("Cookie", owner).expect(200);
    expect(former.body.student).toMatchObject({ isActive: false, currentStay: null, nextDueDate: null });
    expect(former.body.student.stays).toHaveLength(1);
    expect(former.body.student.stays[0]).toMatchObject({ bedId: s.bed1, endedOn: hostelToday() });

    // Back today in the other bed: the old password is gone, the new one must be changed.
    const back = await request(app)
      .post(`/api/students/${id}/reactivate`)
      .set("Cookie", owner)
      .send({ joiningDate: hostelToday(), buildingId: s.building, roomId: s.room, bedId: s.bed2 });
    expect(back.status).toBe(200);
    expect(back.headers["cache-control"]).toBe("no-store");
    expect(await loginStatus(email, "Meera-Own-Password-1")).toBe(401);

    const again = await login(email, back.body.temporaryPassword);
    const held = await request(app).get("/api/structure").set("Cookie", again);
    expect(held.status).toBe(403);
    expect(held.body.error.code).toBe("password_change_required");

    const profile = await request(app).get(`/api/students/${id}`).set("Cookie", owner).expect(200);
    expect(profile.body.student).toMatchObject({
      isActive: true,
      deactivatedAt: null,
      joiningDate: hostelToday(),
      mustChangePassword: true,
    });
    expect(profile.body.student.currentStay).toMatchObject({ bedId: s.bed2, startedOn: hostelToday() });
    expect(profile.body.student.stays).toHaveLength(2);
  });
});

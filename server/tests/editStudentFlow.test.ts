import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStructure, testPool } from "./helpers/db";

// Editing a student, end to end through the real app and database, nothing mocked: the
// owner corrects the details, the profile shows them, the student keeps their password
// and their place, and logs in with the corrected email.
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

describe("editing a student", { timeout: 60_000 }, () => {
  it("corrects the details and nothing else", async () => {
    const s = await insertStructure(db);
    const email = `typo-${randomUUID()}@test.local`;
    const corrected = `fixed-${randomUUID()}@test.local`;
    const owner = await login(ownerEmail, OWNER_PASSWORD);

    const admitted = await request(app)
      .post("/api/students")
      .set("Cookie", owner)
      .send({
        name: "Kiran Mehta",
        email,
        phone: "9123456786",
        parentPhone: "9123456787",
        category: "other",
        joiningDate: "2026-01-14",
        foodPreference: "veg",
        monthlyFee: 5000,
        buildingId: s.building,
        roomId: s.room,
        bedId: s.bed1,
      });
    expect(admitted.status).toBe(201);
    const id: number = admitted.body.student.id;

    const edited = await request(app)
      .patch(`/api/students/${id}`)
      .set("Cookie", owner)
      .send({
        name: "Kiran S. Mehta",
        email: corrected,
        phone: "9123456788",
        parentPhone: "9123456787",
        category: "working",
        company: "Acme Ltd",
        foodPreference: "non_veg",
        vegDays: [4],
        monthlyFee: 5500,
      });
    expect(edited.status).toBe(200);
    expect(edited.body.student).toMatchObject({
      id,
      name: "Kiran S. Mehta",
      email: corrected,
      phone: "9123456788",
      category: "working",
      company: "Acme Ltd",
      collegeName: null,
      foodPreference: "non_veg",
      vegDays: [4],
      monthlyFee: 5500,
      joiningDate: "2026-01-14",
      isActive: true,
      mustChangePassword: true,
    });
    expect(edited.body.student.stays).toHaveLength(1);
    expect(edited.body.student.stays[0]).toMatchObject({ bedId: s.bed1, startedOn: "2026-01-14", endedOn: null });

    // The same temporary password still works, now with the corrected email only.
    expect((await request(app).post("/api/auth/login").send({ email, password: admitted.body.temporaryPassword })).status).toBe(401);
    await login(corrected, admitted.body.temporaryPassword);
  });
});

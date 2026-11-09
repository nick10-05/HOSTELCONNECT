import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { withHostel } from "../src/db";
import { GoogleTokenError, type GoogleAuth } from "../src/lib/google";
import { TERMS_VERSION } from "../src/lib/legal";
import { hashPassword } from "../src/lib/password";
import { insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// PATCH /api/hostel (multi-tenant phase 4a): an owner renames their hostel or changes its
// address. Hostels are made the way owners make them, by signing up.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

function fakeGoogle(): GoogleAuth {
  let started: { nonce: string; challenge: string } | undefined;
  return {
    authUrl({ state, nonce, codeChallenge }) {
      started = { nonce, challenge: codeChallenge };
      return `https://accounts.google.test/auth?state=${state}`;
    },
    async exchangeCode(code, verifier) {
      if (createHash("sha256").update(verifier).digest("base64url") !== started?.challenge) {
        throw new GoogleTokenError("PKCE verifier does not match");
      }
      return `token:${code.slice(5)}`;
    },
    async verifyIdToken(idToken, nonce) {
      if (nonce !== started?.nonce) throw new GoogleTokenError("nonce does not match");
      return { sub: idToken.slice(6), email: `${idToken.slice(6)}@gmail.com` };
    },
  };
}

// Each sign-up gets an app of its own (the per-address sign-up limit is per app); they
// all share the one database.
const newApp = () => createApp({ db, jwtSecret: SECRET, google: fakeGoogle(), signupsOpen: true });
const app = newApp();
const RUN = `hp-${randomUUID().slice(0, 8)}`;
let slugs = 0;
const newSlug = () => `${RUN}-${++slugs}`;

// A new hostel and its owner, signed in.
async function newHostel(name = "Green Leaf") {
  const agent = request.agent(newApp());
  const begin = await agent.get("/api/auth/google/start");
  const state = new URL(begin.headers.location).searchParams.get("state")!;
  await agent.get(`/api/auth/google/callback?state=${state}&code=code:g${randomUUID().replaceAll("-", "")}`);
  const slug = newSlug();
  const made = await agent
    .post("/api/signup")
    .send({ ownerName: "Owner", hostelName: name, slug, acceptTerms: true, termsVersion: TERMS_VERSION });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const [{ id }] = await asAdmin<{ id: number }>("SELECT id::int FROM hostels WHERE slug = $1", [slug]);
  return { agent, slug, id };
}

async function asAdmin<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    return (await admin.query<T>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

const hostelRow = async (id: number) =>
  (await asAdmin<{ name: string; slug: string }>("SELECT name, slug FROM hostels WHERE id = $1", [id]))[0];

describe("PATCH /api/hostel", () => {
  it("renames the owner's hostel, and changes its address", async () => {
    const { agent, id } = await newHostel();
    const renamed = await agent.patch("/api/hostel").send({ name: "  Blue Door Hostel " });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.hostel.name).toBe("Blue Door Hostel");

    const slug = newSlug();
    const moved = await agent.patch("/api/hostel").send({ slug: slug.toUpperCase() });
    expect(moved.body.hostel).toEqual({ name: "Blue Door Hostel", slug });
    expect(await hostelRow(id)).toEqual({ name: "Blue Door Hostel", slug });
    expect((await agent.get("/api/auth/me")).body.hostel).toEqual({ name: "Blue Door Hostel", slug });
  });

  it("moves the sign-in address: the new one finds the hostel, the old one no longer does and is free again", async () => {
    const { agent, slug: old } = await newHostel("Moving Hostel");
    const slug = newSlug();
    expect((await agent.patch("/api/hostel").send({ slug })).status).toBe(200);
    expect((await request(app).get(`/api/hostels/${slug}`)).body).toEqual({ hostel: { name: "Moving Hostel", slug } });
    expect((await request(app).get(`/api/hostels/${old}`)).status).toBe(404);
    expect((await request(app).get(`/api/signup/slug?slug=${old}`)).body).toEqual({ available: true });
  });

  it("keeps its own address when sent again, and refuses another hostel's or a reserved one", async () => {
    const { agent, slug, id } = await newHostel();
    const other = await newHostel();
    expect((await agent.patch("/api/hostel").send({ slug })).status).toBe(200);

    for (const [taken, code] of [
      [other.slug, "slug_taken"],
      ["sns-hostel", "slug_taken"],
      ["admin", "invalid_slug"],
      ["no", "invalid_slug"],
      ["green--leaf", "invalid_slug"],
    ]) {
      const res = await agent.patch("/api/hostel").send({ slug: taken });
      expect([res.body.error?.code], taken).toEqual([code]);
    }
    expect((await hostelRow(id)).slug).toBe(slug);
    expect((await hostelRow(other.id)).slug).toBe(other.slug);
  });

  it("changes only the signed-in owner's hostel, whatever the request names", async () => {
    const { agent } = await newHostel("Mine");
    const other = await newHostel("Theirs");
    const before1 = await hostelRow(1);
    const res = await agent.patch("/api/hostel").send({ name: "Taken Over", id: other.id, hostelId: 1 });
    expect(res.status).toBe(200);
    expect(await hostelRow(other.id)).toMatchObject({ name: "Theirs" });
    expect(await hostelRow(1)).toEqual(before1);
  });

  it("checks the name, and needs something to change", async () => {
    const { agent, id } = await newHostel("Kept");
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(101) }, { name: "a\u0000b" }, { name: 5 }]) {
      expect((await agent.patch("/api/hostel").send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await hostelRow(id)).name).toBe("Kept");
  });

  it("is for the owner: not a student, not someone signed out", async () => {
    const { slug, id } = await newHostel("Owners Only");
    const email = await withHostel(db, id, async (tx) => {
      const studentId = await insertStudent(tx, { passwordHash, mustChangePassword: false });
      return (await tx.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [studentId])).rows[0].email;
    });
    const student = request.agent(app);
    const login = await student.post("/api/auth/login").send({ email, password: PASSWORD, hostel: slug });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    expect((await student.patch("/api/hostel").send({ name: "Student Hostel" })).status).toBe(403);
    expect((await request(app).patch("/api/hostel").send({ name: "Nobody" })).status).toBe(401);
    expect((await hostelRow(id)).name).toBe("Owners Only");
  });
});

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { withHostel } from "../src/db";
import { hashPassword } from "../src/lib/password";
import { isSlug } from "../src/services/hostels";
import { insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Multi-tenant phase 3a: every hostel has its own address, /h/<slug>/. Its students sign
// in there, and former students ask to come back there; the hostel comes from the
// address, never from anything else in the request. Without a hostel, sign-in and the
// form still mean hostel #1 (sns-hostel, migration 019) until phase 6 removes that.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const OTHER_PASSWORD = "Other-Horse-8";
const db = testPool();
let passwordHash: string;
let otherHash: string;

beforeAll(async () => {
  [passwordHash, otherHash] = await Promise.all([hashPassword(PASSWORD), hashPassword(OTHER_PASSWORD)]);
});
afterAll(() => db.end());

const newApp = () => createApp({ db, jwtSecret: SECRET });

// A new hostel with its own slug, committed (the requests run on their own connections).
async function newHostel(name = "Riverside Hostel") {
  const slug = `h-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: number }>("INSERT INTO hostels (name, slug) VALUES ($1, $2) RETURNING id", [
    name,
    slug,
  ]);
  return { id: rows[0].id, slug, name };
}

const emailOf = (hostel: number, id: number) =>
  withHostel(db, hostel, async (tx) => (await tx.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email);

// A student of `hostel` with `email`, committed.
const studentIn = (hostel: number, opts: { email?: string; hash?: string; isActive?: boolean } = {}) =>
  withHostel(db, hostel, async (tx) => {
    const id = await insertStudent(tx, { passwordHash: opts.hash ?? passwordHash, isActive: opts.isActive });
    if (opts.email) await tx.query("UPDATE users SET email = $1 WHERE id = $2", [opts.email, id]);
    return id;
  });

async function suspend(hostel: number) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    await admin.query("UPDATE hostels SET status = 'suspended' WHERE id = $1", [hostel]);
  } finally {
    await admin.end();
  }
}

describe("hostel #1's address", () => {
  it("is sns-hostel (migration 019)", async () => {
    const { rows } = await db.query("SELECT slug FROM hostels WHERE id = 1");
    expect(rows).toEqual([{ slug: "sns-hostel" }]);
  });
});

describe("isSlug", () => {
  // The same rule as the hostels.slug check of migration 013 (tenancyTables.test.ts).
  it("accepts and refuses exactly what the database does", () => {
    for (const slug of ["abc", "sns-hostel", "a1b", "hostel-2", `a${"b".repeat(38)}c`]) expect(isSlug(slug), slug).toBe(true);
    for (const slug of ["ab", "-abc", "abc-", "ABC", "a b", "a--b", "a_b", "abc/", `a${"b".repeat(39)}c`, "../admin", ""]) {
      expect(isSlug(slug), slug).toBe(false);
    }
  });
});

describe("GET /api/hostels/:slug", () => {
  it("gives the name of the hostel at that address, and nothing else", async () => {
    const h = await newHostel("Lakeview Hostel");
    const res = await request(newApp()).get(`/api/hostels/${h.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hostel: { name: "Lakeview Hostel", slug: h.slug } });
  });

  it("answers 404 for an address no hostel has, a malformed one, or a suspended hostel", async () => {
    const h = await newHostel();
    await suspend(h.id);
    for (const slug of ["no-such-hostel-here", "Bad_Slug", "x", h.slug]) {
      const res = await request(newApp()).get(`/api/hostels/${encodeURIComponent(slug)}`);
      expect(res.status, slug).toBe(404);
      expect(res.body.error.code, slug).toBe("hostel_not_found");
    }
  });
});

describe("signing in at a hostel's address", { timeout: 30_000 }, () => {
  it("signs a student in to the hostel named, where the same email may belong to someone else", async () => {
    const h = await newHostel();
    const email = `shared-${randomUUID()}@test.local`;
    const inOne = await studentIn(1, { email, hash: otherHash });
    const inH = await studentIn(h.id, { email });

    const res = await request(newApp()).post("/api/auth/login").send({ hostel: h.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(inH);
    // The same email at hostel #1 is the other account, with its own password.
    const one = await request(newApp())
      .post("/api/auth/login")
      .send({ hostel: "sns-hostel", email, password: OTHER_PASSWORD });
    expect(one.body.user.id).toBe(inOne);
    // And without a hostel, still hostel #1 (until phase 6).
    const none = await request(newApp()).post("/api/auth/login").send({ email, password: OTHER_PASSWORD });
    expect(none.body.user.id).toBe(inOne);
  });

  it("never signs in an account of another hostel, with the same answer as a wrong password", async () => {
    const h = await newHostel();
    const id = await studentIn(1);
    const email = await emailOf(1, id);
    const res = await request(newApp()).post("/api/auth/login").send({ hostel: h.slug, email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_credentials");
  });

  it("answers an unknown or suspended hostel like a wrong password", async () => {
    const h = await newHostel();
    const id = await studentIn(h.id);
    const email = await emailOf(h.id, id);
    await suspend(h.id);
    for (const hostel of [h.slug, "no-such-hostel-here"]) {
      const res = await request(newApp()).post("/api/auth/login").send({ hostel, email, password: PASSWORD });
      expect(res.status, hostel).toBe(401);
      expect(res.body.error.code, hostel).toBe("invalid_credentials");
    }
    // Nor does such an address fall back to hostel #1, as a request naming no hostel does.
    const one = await emailOf(1, await studentIn(1));
    for (const hostel of [h.slug, "no-such-hostel-here"]) {
      const res = await request(newApp()).post("/api/auth/login").send({ hostel, email: one, password: PASSWORD });
      expect(res.status, `hostel #1's account at ${hostel}`).toBe(401);
    }
  });

  it("refuses a hostel that is not a valid address", async () => {
    const res = await request(newApp())
      .post("/api/auth/login")
      .send({ hostel: "../admin", email: "someone@test.local", password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it("tells the signed-in user which hostel they are in", async () => {
    const h = await newHostel("Hilltop Hostel");
    const id = await studentIn(h.id);
    const agent = request.agent(newApp());
    await agent.post("/api/auth/login").send({ hostel: h.slug, email: await emailOf(h.id, id), password: PASSWORD });
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.hostel).toEqual({ name: "Hilltop Hostel", slug: h.slug });
    expect(me.body.user.id).toBe(id);
  });
});

describe("asking to come back, at a hostel's address", () => {
  const pendingFor = (hostel: number, student: number) =>
    withHostel(db, hostel, async (tx) =>
      (await tx.query("SELECT 1 FROM rejoin_requests WHERE student_id = $1 AND status = 'pending'", [student])).rowCount,
    );

  it("files the request in the hostel named, never in another with the same email", async () => {
    const h = await newHostel();
    const email = `former-${randomUUID()}@test.local`;
    const inOne = await studentIn(1, { email, isActive: false });
    const inH = await studentIn(h.id, { email, isActive: false });

    const res = await request(newApp()).post("/api/rejoin-requests").send({ hostel: h.slug, email });
    expect(res.status).toBe(202);
    expect(await pendingFor(h.id, inH)).toBe(1);
    expect(await pendingFor(1, inOne)).toBe(0);
  });

  it("answers 404 for an unknown or suspended hostel, and files nothing", async () => {
    const h = await newHostel();
    const email = `former-${randomUUID()}@test.local`;
    const inH = await studentIn(h.id, { email, isActive: false });
    await suspend(h.id);
    for (const hostel of [h.slug, "no-such-hostel-here"]) {
      const res = await request(newApp()).post("/api/rejoin-requests").send({ hostel, email });
      expect(res.status, hostel).toBe(404);
      expect(res.body.error.code, hostel).toBe("hostel_not_found");
    }
    expect(await pendingFor(h.id, inH)).toBe(0);
  });
});

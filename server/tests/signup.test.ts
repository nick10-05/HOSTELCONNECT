import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { withHostel } from "../src/db";
import { GoogleTokenError, type GoogleAuth } from "../src/lib/google";
import { TERMS_VERSION } from "../src/lib/legal";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { SIGNUP_COOKIE } from "../src/routes/signup";
import { checkSlug } from "../src/services/hostels";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Sign-up through the real app (multi-tenant phase 4a): Google (a fake, as in
// googleSignIn.test.ts) hands back an account no owner has; with sign-up open that account
// gets a ticket, and with the ticket creates a hostel and becomes its one owner.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

// A code is "code:<google account id>"; the account's email is <id>@gmail.com.
function fakeGoogle(): GoogleAuth {
  let started: { nonce: string; challenge: string } | undefined;
  return {
    authUrl({ state, nonce, codeChallenge }) {
      started = { nonce, challenge: codeChallenge };
      return `https://accounts.google.test/auth?state=${state}`;
    },
    async exchangeCode(code, verifier) {
      if (!code.startsWith("code:")) throw new GoogleTokenError("Google refused the code");
      if (createHash("sha256").update(verifier).digest("base64url") !== started?.challenge) {
        throw new GoogleTokenError("PKCE verifier does not match");
      }
      return `token:${code.slice(5)}`;
    },
    async verifyIdToken(idToken, nonce) {
      if (nonce !== started?.nonce) throw new GoogleTokenError("nonce does not match");
      const sub = idToken.slice(6);
      return { sub, email: `${sub}@gmail.com` };
    },
  };
}

type Options = { google?: boolean; open?: boolean };
const appWith = ({ google = true, open = true }: Options = {}) =>
  createApp({ db, jwtSecret: SECRET, google: google ? fakeGoogle() : null, signupsOpen: open });

const newSub = () => `g${randomUUID().replaceAll("-", "")}`;
// Every address this file makes starts with RUN, so counting hostels counts only its own
// (other test files make hostels at the same time).
const RUN = `su-${randomUUID().slice(0, 8)}`;
let slugs = 0;
const newSlug = () => `${RUN}-${++slugs}`;

function cookieNamed(res: request.Response, name: string): string | undefined {
  return ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`));
}

async function viaGoogle(agent: request.Agent, sub: string) {
  const begin = await agent.get("/api/auth/google/start");
  expect(begin.status, JSON.stringify(begin.body)).toBe(302);
  const state = new URL(begin.headers.location).searchParams.get("state")!;
  return agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=code:${sub}`);
}

// An agent back from Google with a sign-up ticket for a new Google account.
async function withTicket(app = appWith(), sub = newSub()) {
  const agent = request.agent(app);
  const back = await viaGoogle(agent, sub);
  expect(back.status).toBe(302);
  expect(back.headers.location).toBe("/signup");
  return { agent, sub, back };
}

const form = (over: Record<string, unknown> = {}) => ({
  ownerName: "Asha Rao",
  hostelName: "Green Leaf Hostel",
  slug: newSlug(),
  acceptTerms: true,
  termsVersion: TERMS_VERSION,
  ...over,
});

async function asAdmin<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    return (await admin.query<T>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

const hostelCount = async () =>
  Number((await asAdmin<{ n: string }>("SELECT count(*) AS n FROM hostels WHERE slug LIKE $1", [`${RUN}-%`]))[0].n);

describe("whether sign-up is open", () => {
  it("is closed by default: an unknown Google account is told it has no account, and the sign-up addresses refuse", async () => {
    const app = createApp({ db, jwtSecret: SECRET, google: fakeGoogle() });
    expect((await request(app).get("/api/auth/options")).body).toEqual({ google: true, signupsOpen: false });

    const agent = request.agent(app);
    const back = await viaGoogle(agent, newSub());
    expect(back.headers.location).toBe("/login?google=no-account");
    expect(cookieNamed(back, SIGNUP_COOKIE)).toBeUndefined();

    expect((await agent.get("/api/signup")).body.error.code).toBe("signups_closed");
    const before = await hostelCount();
    const res = await agent.post("/api/signup").send(form());
    expect([res.status, res.body.error.code]).toEqual([403, "signups_closed"]);
    expect(await hostelCount()).toBe(before);
  });

  it("stays closed without Google sign-in, whatever SIGNUPS_OPEN says", async () => {
    const app = appWith({ google: false, open: true });
    expect((await request(app).get("/api/auth/options")).body).toEqual({ google: false, signupsOpen: false });
    expect((await request(app).post("/api/signup").send(form())).status).toBe(403);
  });

  it("is open with both", async () => {
    expect((await request(appWith()).get("/api/auth/options")).body).toEqual({ google: true, signupsOpen: true });
  });
});

describe("the sign-up ticket", () => {
  it("is given to an unknown Google account: httpOnly, on /api/signup only, 30 minutes; it holds the verified email", async () => {
    const { agent, sub, back } = await withTicket();
    const cookie = cookieNamed(back, SIGNUP_COOKIE)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/signup(;|$)/);
    expect(cookie).toMatch(/Max-Age=1800/);
    expect(cookieNamed(back, SESSION_COOKIE)).toBeUndefined();

    const res = await agent.get("/api/signup");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: `${sub}@gmail.com`, termsVersion: TERMS_VERSION });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is not given to a Google account an owner already has: that owner is signed in", async () => {
    const sub = newSub();
    await withHostel(db, 1, async (tx) => {
      const id = await insertOwner(tx, { passwordHash });
      await tx.query("UPDATE users SET google_sub = $1 WHERE id = $2", [sub, id]);
    });
    const back = await viaGoogle(request.agent(appWith()), sub);
    expect(back.headers.location).toBe("/");
    expect(cookieNamed(back, SIGNUP_COOKIE)).toBeUndefined();
    expect(cookieNamed(back, SESSION_COOKIE)).toBeDefined();
  });

  it("is needed: without one, or with a forged or wrong-kind one, nothing is made", async () => {
    const app = appWith();
    const before = await hostelCount();
    const none = await request(app).get("/api/signup");
    expect([none.status, none.body.error.code]).toEqual([401, "signup_not_started"]);
    expect((await request(app).post("/api/signup").send(form())).status).toBe(401);

    const forged = `${SIGNUP_COOKIE}=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4IiwiZW1haWwiOiJ4QHguY28ifQ.`;
    expect((await request(app).post("/api/signup").set("Cookie", forged).send(form())).status).toBe(401);

    // A session token is signed with the same secret, but is not a sign-up ticket.
    const { agent } = await withTicket(app);
    const made = await agent.post("/api/signup").send(form());
    expect(made.status).toBe(201);
    const sessionToken = cookieNamed(made, SESSION_COOKIE)!.split(";")[0].split("=")[1];
    const wrongKind = await request(app).post("/api/signup").set("Cookie", `${SIGNUP_COOKIE}=${sessionToken}`).send(form());
    expect([wrongKind.status, wrongKind.body.error.code]).toEqual([401, "signup_not_started"]);
    // Signed with the same secret and shaped like a ticket, but for another purpose.
    const otherPurpose = jwt.sign({ sub: newSub(), email: "x@gmail.com" }, SECRET, { algorithm: "HS256", expiresIn: 600 });
    const res = await request(app).post("/api/signup").set("Cookie", `${SIGNUP_COOKIE}=${otherPurpose}`).send(form());
    expect([res.status, res.body.error.code]).toEqual([401, "signup_not_started"]);
    expect(await hostelCount()).toBe(before + 1);
  });
});

describe("POST /api/signup", () => {
  it("creates the hostel and its one owner, signs the owner in, and ends the ticket", async () => {
    const { agent, sub } = await withTicket();
    const slug = newSlug();
    const res = await agent.post("/api/signup").send(form({ ownerName: "  Asha Rao ", hostelName: " Green Leaf ", slug: ` ${slug.toUpperCase()} ` }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Asha Rao", role: "owner", mustChangePassword: false });
    expect(cookieNamed(res, SIGNUP_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.hostel).toEqual({ name: "Green Leaf", slug });
    expect(me.body.account).toEqual({ googleLinked: true, hasPassword: false });

    const [row] = await asAdmin(
      `SELECT u.hostel_id::int AS user_hostel, h.id::int AS hostel, u.email, u.google_sub, u.password_hash,
              u.terms_version, u.terms_accepted_at > now() - interval '1 minute' AS just_now,
              (SELECT count(*)::int FROM users WHERE hostel_id = h.id) AS people, h.status
         FROM hostels h JOIN users u ON u.hostel_id = h.id WHERE h.slug = $1`,
      [slug],
    );
    expect(row).toMatchObject({
      email: `${sub}@gmail.com`,
      google_sub: sub,
      password_hash: null,
      terms_version: TERMS_VERSION,
      just_now: true,
      people: 1,
      status: "active",
    });
    expect(row.user_hostel).toBe(row.hostel);
    expect(row.hostel).not.toBe(1);

    // The ticket is spent: a second sign-up with the same agent is not started.
    expect((await agent.post("/api/signup").send(form())).status).toBe(401);
  });

  it("never attaches an owner to an existing hostel: a taken address is refused, and that hostel keeps its one owner", async () => {
    const { agent, sub } = await withTicket();
    const before = await hostelCount();

    const res = await agent.post("/api/signup").send(form({ slug: "sns-hostel" }));
    expect([res.status, res.body.error.code]).toEqual([409, "slug_taken"]);
    // Asking for a hostel by its id is not a thing sign-up understands.
    const byId = await agent.post("/api/signup").send({ ...form(), hostelId: 1, hostel_id: 1 });
    expect(byId.status).toBe(201);
    const [made] = await asAdmin<{ hostel_id: number }>("SELECT hostel_id::int FROM users WHERE id = $1", [byId.body.user.id]);
    expect(made.hostel_id).not.toBe(1);

    // Other test files add owners to hostel #1 meanwhile, so look for this account only.
    const inHostel1 = await asAdmin("SELECT 1 FROM users WHERE hostel_id = 1 AND google_sub = $1", [sub]);
    expect(inHostel1).toEqual([]);
    expect(await hostelCount()).toBe(before + 1);
  });

  it("lets one Google account own one hostel only", async () => {
    const app = appWith();
    const sub = newSub();
    const first = await withTicket(app, sub);
    expect((await first.agent.post("/api/signup").send(form())).status).toBe(201);

    // Signing in again with that account signs the owner in; it is no longer new.
    const again = await viaGoogle(request.agent(app), sub);
    expect(again.headers.location).toBe("/");

    // A ticket taken before the first sign-up finished cannot make a second hostel.
    const app2 = appWith();
    const sub2 = newSub();
    const a = await withTicket(app2, sub2);
    const b = await withTicket(app2, sub2);
    expect((await a.agent.post("/api/signup").send(form())).status).toBe(201);
    const before = await hostelCount();
    const second = await b.agent.post("/api/signup").send(form());
    expect([second.status, second.body.error.code]).toEqual([409, "already_signed_up"]);
    expect(await hostelCount()).toBe(before);
  });

  it("needs the terms accepted, and the version this page showed", async () => {
    const { agent } = await withTicket();
    const before = await hostelCount();
    for (const acceptTerms of [false, undefined, "true", 1]) {
      const res = await agent.post("/api/signup").send(form({ acceptTerms }));
      expect(res.status, String(acceptTerms)).toBe(400);
    }
    const old = await agent.post("/api/signup").send(form({ termsVersion: "2020-01" }));
    expect([old.status, old.body.error.code]).toEqual([409, "terms_changed"]);
    expect(await hostelCount()).toBe(before);
  });

  it("checks the names and the address", async () => {
    const { agent } = await withTicket();
    const before = await hostelCount();
    const bad: Record<string, unknown>[] = [
      { ownerName: "  " },
      { hostelName: "" },
      { hostelName: "x".repeat(101) },
      { ownerName: "a\u0000b" },
      { slug: "ab" },
      { slug: "-green" },
      { slug: "green--leaf" },
      { slug: "green_leaf" },
      { slug: "admin" },
      { slug: "signup" },
    ];
    for (const over of bad) {
      const res = await agent.post("/api/signup").send(form(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    expect(await hostelCount()).toBe(before);
  });
});

describe("the limit on sign-ups", () => {
  it("lets one address make five hostels an hour; refused attempts do not count", async () => {
    const app = appWith();
    const { agent } = await withTicket(app);
    for (let i = 0; i < 8; i++) expect((await agent.post("/api/signup").send(form({ slug: "x" }))).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      const { agent: next } = await withTicket(app);
      expect((await next.post("/api/signup").send(form())).status).toBe(201);
    }
    const before = await hostelCount();
    const { agent: sixth } = await withTicket(app);
    const res = await sixth.post("/api/signup").send(form());
    expect([res.status, res.body.error.code]).toEqual([429, "rate_limited"]);
    expect(await hostelCount()).toBe(before);
  });
});

describe("GET /api/signup/slug", () => {
  it("says whether an address is free, and why not", async () => {
    const app = appWith();
    const check = async (slug: string) => (await request(app).get(`/api/signup/slug?slug=${encodeURIComponent(slug)}`)).body;
    expect(await check(newSlug())).toEqual({ available: true });
    expect(await check("SNS-Hostel")).toEqual({ available: false, reason: "taken" });
    expect(await check("support")).toEqual({ available: false, reason: "reserved" });
    expect(await check("a")).toEqual({ available: false, reason: "invalid" });
    expect((await request(app).get("/api/signup/slug")).body).toEqual({ available: false, reason: "invalid" });
  });

  it("counts a suspended hostel's address as taken", async () => {
    const slug = newSlug();
    await asAdmin("INSERT INTO hostels (name, slug, status) VALUES ('Closed', $1, 'suspended')", [slug]);
    expect(await checkSlug(db, slug)).toEqual({ available: false, reason: "taken" });
  });
});

describe("migration 021", () => {
  it("keeps the accepted terms with owners only, version and time together", async () => {
    const { ownerId, studentId } = await withHostel(db, 1, async (tx) => ({
      ownerId: await insertOwner(tx, { passwordHash }),
      studentId: await insertStudent(tx, { passwordHash }),
    }));
    const refused = [
      ["terms_version = 'v1'", ownerId],
      ["terms_accepted_at = now()", ownerId],
      ["terms_version = ' v1', terms_accepted_at = now()", ownerId],
      ["terms_version = '', terms_accepted_at = now()", ownerId],
      [`terms_version = '${"v".repeat(41)}', terms_accepted_at = now()`, ownerId],
      ["terms_version = 'v1', terms_accepted_at = now()", studentId],
    ] as const;
    for (const [set, id] of refused) {
      const result = await asAdmin(`UPDATE users SET ${set} WHERE id = $1`, [id]).then(
        () => "updated",
        (err: { code?: string }) => err.code,
      );
      expect(result, `${set} for ${id === ownerId ? "owner" : "student"}`).toBe("23514");
    }
    await asAdmin("UPDATE users SET terms_version = 'v1', terms_accepted_at = now() WHERE id = $1", [ownerId]);
  });
});

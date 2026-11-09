import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { withHostel } from "../src/db";
import { GoogleTokenError, type GoogleAuth } from "../src/lib/google";
import { hashPassword } from "../src/lib/password";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { FLOW_COOKIE } from "../src/routes/google";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Google sign-in for owners through the real app (multi-tenant phase 3b). Google itself is
// a fake that plays its part honestly: it hands out a code for a chosen Google account,
// and gives the ID token only for the PKCE verifier and nonce this sign-in started with.
// tests/google.test.ts checks the real token checks.
const SECRET = "test-secret-that-is-at-least-32-characters";
const PASSWORD = "Correct-Horse-7";
const db = testPool();
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => db.end());

function fakeGoogle() {
  let started: { nonce: string; challenge: string } | undefined;
  const google: GoogleAuth & { refuse: boolean } = {
    refuse: false,
    authUrl({ state, nonce, codeChallenge }) {
      started = { nonce, challenge: codeChallenge };
      return `https://accounts.google.test/auth?state=${state}`;
    },
    // A code is "code:<google account id>".
    async exchangeCode(code, verifier) {
      if (google.refuse || !code.startsWith("code:")) throw new GoogleTokenError("Google refused the code");
      if (createHash("sha256").update(verifier).digest("base64url") !== started?.challenge) {
        throw new GoogleTokenError("PKCE verifier does not match");
      }
      return `token:${code.slice(5)}`;
    },
    async verifyIdToken(idToken, nonce) {
      if (nonce !== started?.nonce) throw new GoogleTokenError("nonce does not match");
      return { sub: idToken.slice(6), email: "owner@gmail.com" };
    },
  };
  return google;
}

const newSub = () => `google-${randomUUID()}`;
const appWith = (google: GoogleAuth | null) => createApp({ db, jwtSecret: SECRET, google });

function cookieNamed(res: request.Response, name: string): string | undefined {
  return ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`));
}

// Starts a sign-in (or a link) on `agent` and comes back from Google with `code`.
async function viaGoogle(agent: request.Agent, code: string, start = "/api/auth/google/start") {
  const begin = await agent.get(start);
  expect(begin.status, JSON.stringify(begin.body)).toBe(302);
  const state = new URL(begin.headers.location).searchParams.get("state")!;
  return agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
}

// An owner of `hostel` (default hostel #1), committed, with a password and maybe Google.
async function owner(opts: { hostel?: number; sub?: string; isActive?: boolean } = {}) {
  return withHostel(db, opts.hostel ?? 1, async (tx) => {
    const id = await insertOwner(tx, { passwordHash, isActive: opts.isActive });
    if (opts.sub) await tx.query("UPDATE users SET google_sub = $1 WHERE id = $2", [opts.sub, id]);
    const { rows } = await tx.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id]);
    return { id, email: rows[0].email };
  });
}

const accountOf = (id: number, hostel = 1) =>
  withHostel(db, hostel, async (tx) =>
    (await tx.query("SELECT google_sub, password_hash IS NOT NULL AS has_password FROM users WHERE id = $1", [id])).rows[0],
  );

async function asAdmin(sql: string, params: unknown[]) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    return await admin.query(sql, params);
  } finally {
    await admin.end();
  }
}

async function signedIn(app: ReturnType<typeof appWith>, email: string) {
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

describe("whether Google sign-in is on", () => {
  it("is off without the settings: the sign-in page hides it and its addresses do not exist", async () => {
    const app = appWith(null);
    expect((await request(app).get("/api/auth/options")).body).toEqual({ google: false });
    expect((await request(app).get("/api/auth/google/start")).status).toBe(404);
    expect((await request(app).get("/api/auth/google/callback?state=x&code=y")).status).toBe(404);
  });

  it("is on with them", async () => {
    expect((await request(appWith(fakeGoogle())).get("/api/auth/options")).body).toEqual({ google: true });
  });
});

describe("signing in with Google", () => {
  it("starts by sending the browser to Google, remembering the sign-in in a short, httpOnly cookie", async () => {
    const res = await request(appWith(fakeGoogle())).get("/api/auth/google/start");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=[\w-]{43}$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const flow = cookieNamed(res, FLOW_COOKIE);
    expect(flow).toMatch(/HttpOnly/i);
    expect(flow).toMatch(/SameSite=Lax/i);
    expect(flow).toMatch(/Path=\/api\/auth\/google/);
    expect(flow).toMatch(/Max-Age=600/);
  });

  it("signs in the owner whose Google account it is, in whichever hostel they are", async () => {
    const hostel = (await db.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Google Hostel') RETURNING id")).rows[0].id;
    const sub = newSub();
    const o = await owner({ hostel, sub });
    const agent = request.agent(appWith(fakeGoogle()));

    const res = await viaGoogle(agent, `code:${sub}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(cookieNamed(res, SESSION_COOKIE)).toMatch(/HttpOnly/i);
    const me = await agent.get("/api/auth/me");
    expect(me.body.user).toMatchObject({ id: o.id, role: "owner" });
    expect(me.body.hostel.name).toBe("Google Hostel");
  });

  it("finds no one for a Google account no owner has linked", async () => {
    const res = await viaGoogle(request.agent(appWith(fakeGoogle())), `code:${newSub()}`);
    expect(res.headers.location).toBe("/login?google=no-account");
    expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
  });

  it("does not sign in a deactivated owner, or an owner of a suspended hostel", async () => {
    const off = newSub();
    await owner({ sub: off, isActive: false });
    const hostel = (await db.query<{ id: number }>("INSERT INTO hostels (name) VALUES ('Suspended') RETURNING id")).rows[0].id;
    const suspended = newSub();
    await owner({ hostel, sub: suspended });
    await asAdmin("UPDATE hostels SET status = 'suspended' WHERE id = $1", [hostel]);
    for (const sub of [off, suspended]) {
      const res = await viaGoogle(request.agent(appWith(fakeGoogle())), `code:${sub}`);
      expect(res.headers.location, sub).toBe("/login?google=inactive");
      expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("refuses a callback that is not the end of this browser's own sign-in", async () => {
    const sub = newSub();
    await owner({ sub });
    const google = fakeGoogle();
    const app = appWith(google);
    const fail = "/login?google=failed";

    // No sign-in started in this browser (a link sent by someone else).
    expect((await request(app).get(`/api/auth/google/callback?state=x&code=code:${sub}`)).headers.location).toBe(fail);
    // Another state than the one this sign-in started with.
    const agent = request.agent(app);
    await agent.get("/api/auth/google/start");
    const wrong = await agent.get(`/api/auth/google/callback?state=not-the-state&code=code:${sub}`);
    expect(wrong.headers.location).toBe(fail);
    expect(cookieNamed(wrong, SESSION_COOKIE)).toBeUndefined();
    // A callback is good once: the flow cookie is cleared by it, so the very same callback
    // again (a replayed or bookmarked URL) does nothing.
    const begin = await agent.get("/api/auth/google/start");
    const callback = `/api/auth/google/callback?state=${new URL(begin.headers.location).searchParams.get("state")}&code=code:${sub}`;
    const first = await agent.get(callback);
    expect(first.headers.location).toBe("/");
    expect(cookieNamed(first, FLOW_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/);
    const replay = await request.agent(app).get(callback).set("Cookie", "");
    expect(replay.headers.location).toBe(fail);
    expect((await agent.get(callback)).headers.location).toBe(fail);
    // Google refuses the code.
    google.refuse = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await viaGoogle(request.agent(app), `code:${sub}`)).headers.location).toBe(fail);
      expect(warn).toHaveBeenCalledWith("Google sign-in failed:", "Google refused the code");
    } finally {
      warn.mockRestore();
    }
  });

  it("says cancelled when the owner says no at Google", async () => {
    const agent = request.agent(appWith(fakeGoogle()));
    const begin = await agent.get("/api/auth/google/start");
    const state = new URL(begin.headers.location).searchParams.get("state")!;
    const res = await agent.get(`/api/auth/google/callback?state=${state}&error=access_denied`);
    expect(res.headers.location).toBe("/login?google=cancelled");
  });
});

describe("linking a Google account", { timeout: 30_000 }, () => {
  it("links the signed-in owner's account, after which Google signs them in", async () => {
    const o = await owner();
    const sub = newSub();
    const app = appWith(fakeGoogle());
    const agent = await signedIn(app, o.email);

    const res = await viaGoogle(agent, `code:${sub}`, "/api/auth/google/link");
    expect(res.headers.location).toBe("/settings?google=linked");
    expect(await accountOf(o.id)).toEqual({ google_sub: sub, has_password: true });
    expect((await agent.get("/api/auth/me")).body.account).toEqual({ googleLinked: true, hasPassword: true });

    const again = await viaGoogle(request.agent(app), `code:${sub}`);
    expect(again.headers.location).toBe("/");
  });

  it("refuses a Google account another HostelConnect account already uses", async () => {
    const sub = newSub();
    await owner({ sub });
    const o = await owner();
    const res = await viaGoogle(await signedIn(appWith(fakeGoogle()), o.email), `code:${sub}`, "/api/auth/google/link");
    expect(res.headers.location).toBe("/settings?google=taken");
    expect((await accountOf(o.id)).google_sub).toBeNull();
  });

  it("never replaces a Google account already linked", async () => {
    const first = newSub();
    const o = await owner({ sub: first });
    const res = await viaGoogle(await signedIn(appWith(fakeGoogle()), o.email), `code:${newSub()}`, "/api/auth/google/link");
    expect(res.headers.location).toBe("/settings?google=already-linked");
    expect((await accountOf(o.id)).google_sub).toBe(first);
  });

  it("is for signed-in owners only, and only while still signed in as them", async () => {
    const app = appWith(fakeGoogle());
    expect((await request(app).get("/api/auth/google/link")).status).toBe(401);

    const student = await withHostel(db, 1, async (tx) => {
      const id = await insertStudent(tx, { passwordHash });
      return (await tx.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
    });
    expect((await (await signedIn(app, student)).get("/api/auth/google/link")).status).toBe(403);

    // Signed out between the start and Google's answer: nothing is linked.
    const o = await owner();
    const agent = await signedIn(app, o.email);
    const begin = await agent.get("/api/auth/google/link");
    const state = new URL(begin.headers.location).searchParams.get("state")!;
    await agent.post("/api/auth/logout");
    const res = await agent.get(`/api/auth/google/callback?state=${state}&code=code:${newSub()}`);
    expect(res.headers.location).toBe("/settings?google=failed");
    expect((await accountOf(o.id)).google_sub).toBeNull();
  });
});

describe("POST /api/auth/remove-password", { timeout: 30_000 }, () => {
  it("lets an owner with Google linked drop the password, after which only Google signs them in", async () => {
    const sub = newSub();
    const o = await owner({ sub });
    const app = appWith(fakeGoogle());
    const agent = await signedIn(app, o.email);

    const wrong = await agent.post("/api/auth/remove-password").send({ currentPassword: "not-it" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("wrong_password");

    expect((await agent.post("/api/auth/remove-password").send({ currentPassword: PASSWORD })).status).toBe(204);
    expect(await accountOf(o.id)).toEqual({ google_sub: sub, has_password: false });
    expect((await agent.get("/api/auth/me")).body.account).toEqual({ googleLinked: true, hasPassword: false });
    // The password no longer works; Google does.
    expect((await request(app).post("/api/auth/login").send({ email: o.email, password: PASSWORD })).status).toBe(401);
    expect((await viaGoogle(request.agent(app), `code:${sub}`)).headers.location).toBe("/");
    // Nothing left to change or remove.
    const change = await agent.post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: "A-new-password-9" });
    expect(change.body.error.code).toBe("no_password");
    const again = await agent.post("/api/auth/remove-password").send({ currentPassword: PASSWORD });
    expect(again.body.error.code).toBe("no_password");
  });

  it("refuses while Google is not linked, and refuses students", async () => {
    const o = await owner();
    const app = appWith(fakeGoogle());
    const res = await (await signedIn(app, o.email)).post("/api/auth/remove-password").send({ currentPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("google_not_linked");
    expect((await accountOf(o.id)).has_password).toBe(true);

    const student = await withHostel(db, 1, async (tx) => {
      const id = await insertStudent(tx, { passwordHash });
      return (await tx.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
    });
    const asStudent = await signedIn(app, student);
    expect((await asStudent.post("/api/auth/remove-password").send({ currentPassword: PASSWORD })).status).toBe(403);
    expect((await asStudent.get("/api/auth/me")).body.account).toEqual({ googleLinked: false, hasPassword: true });
  });
});

describe("auth_owner_by_google_sub", () => {
  it("finds owners only, in any hostel, and is the app's alone to call", async () => {
    const sub = newSub();
    const o = await owner({ sub });
    const { rows } = await db.query("SELECT id, hostel_id, role FROM auth_owner_by_google_sub($1)", [sub]);
    expect(rows).toEqual([{ id: o.id, hostel_id: 1, role: "owner" }]);
    expect((await db.query("SELECT * FROM auth_owner_by_google_sub($1)", [newSub()])).rows).toEqual([]);
    const { rows: rights } = await asAdmin(
      `SELECT has_function_privilege('hostel_app', 'auth_owner_by_google_sub(text)', 'EXECUTE') AS app,
              has_function_privilege('public', 'auth_owner_by_google_sub(text)', 'EXECUTE') AS everyone`,
      [],
    );
    expect(rights).toEqual([{ app: true, everyone: false }]);
  });
});

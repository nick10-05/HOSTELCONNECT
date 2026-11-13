import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// Who may call each API route (security audit). Every route the app has must be listed
// here, so a new route cannot ship without someone deciding who may call it; then each is
// called signed out, as a student, as an owner and as a student who has not yet changed a
// temporary password, and must be refused by its guard, before it does anything.
//   public    no session needed (each has its own protection: login limits, tickets,
//             the job secret, the same answer for every email)
//   signedIn  any signed-in account, student or owner (the answer depends on who asks)
//   owner     owners only        student   students only
// "temporary" marks the routes a student with a temporary password may still use.
type Access = "public" | "signedIn" | "owner" | "student";
const ROUTES: Record<string, { access: Access; temporary?: true }> = {
  "POST /api/auth/login": { access: "public" },
  "POST /api/auth/logout": { access: "public" },
  "GET /api/auth/me": { access: "signedIn", temporary: true },
  "POST /api/auth/change-password": { access: "signedIn", temporary: true },
  "POST /api/auth/remove-password": { access: "owner" },
  "GET /api/auth/options": { access: "public" },
  "GET /api/auth/google/start": { access: "public" },
  "GET /api/auth/google/link": { access: "owner" },
  "GET /api/auth/google/callback": { access: "public" },
  "GET /api/signup": { access: "public" },
  "GET /api/signup/slug": { access: "public" },
  "POST /api/signup": { access: "public" },
  "GET /api/hostel": { access: "owner" },
  "PATCH /api/hostel": { access: "owner" },
  "GET /api/hostels/:slug": { access: "public" },
  "GET /api/structure": { access: "owner" },
  "POST /api/buildings": { access: "owner" },
  "DELETE /api/buildings/:id": { access: "owner" },
  "POST /api/buildings/:id/floors": { access: "owner" },
  "DELETE /api/floors/:id": { access: "owner" },
  "POST /api/buildings/:id/rooms": { access: "owner" },
  "DELETE /api/rooms/:id": { access: "owner" },
  "POST /api/rooms/:id/beds": { access: "owner" },
  "POST /api/beds/:id/retire": { access: "owner" },
  "POST /api/beds/:id/reactivate": { access: "owner" },
  "GET /api/students": { access: "owner" },
  "GET /api/students/:id": { access: "owner" },
  "PATCH /api/students/:id": { access: "owner" },
  "POST /api/students": { access: "owner" },
  "POST /api/students/:id/transfer": { access: "owner" },
  "POST /api/students/:id/deactivate": { access: "owner" },
  "POST /api/students/:id/reset-password": { access: "owner" },
  "POST /api/students/:id/reactivate": { access: "owner" },
  "POST /api/rejoin-requests": { access: "public" },
  "GET /api/rejoin-requests": { access: "owner" },
  "POST /api/rejoin-requests/:id/approve": { access: "owner" },
  "POST /api/rejoin-requests/:id/reject": { access: "owner" },
  "GET /api/notifications": { access: "signedIn" },
  "POST /api/notifications/read-all": { access: "signedIn" },
  "POST /api/notifications/:id/read": { access: "signedIn" },
  "GET /api/dashboard": { access: "owner" },
  "POST /api/complaints": { access: "student" },
  "GET /api/complaints": { access: "signedIn" },
  "GET /api/complaints/:id": { access: "signedIn" },
  "POST /api/complaints/:id/status": { access: "owner" },
  "PATCH /api/complaints/:id": { access: "owner" },
  "POST /api/complaints/:id/notes": { access: "owner" },
  "GET /api/announcements": { access: "signedIn" },
  "POST /api/announcements": { access: "owner" },
  "PATCH /api/announcements/:id": { access: "owner" },
  "DELETE /api/announcements/:id": { access: "owner" },
  "GET /api/return-polls": { access: "signedIn" },
  "POST /api/return-polls": { access: "owner" },
  "GET /api/return-polls/:id": { access: "owner" },
  "PUT /api/return-polls/:id/response": { access: "student" },
  "POST /api/return-polls/:id/close": { access: "owner" },
  "GET /api/food-counts": { access: "owner" },
  "GET /api/fees": { access: "owner" },
  "GET /api/fees/mine": { access: "student" },
  "POST /api/fees/:id/status": { access: "owner" },
  "GET /api/settings/payment": { access: "signedIn" },
  "PUT /api/settings/payment": { access: "owner" },
  "GET /api/settings/payment/qr": { access: "signedIn" },
  "POST /api/internal/run-jobs": { access: "public" },
};

const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
const app = createApp({ db, jwtSecret: SECRET, production: false, jobSecret: "a-job-secret-of-at-least-32-characters!" });
afterAll(() => db.end());

type Layer = {
  name: string;
  matchers: ((path: string) => unknown)[];
  handle: { stack: Layer[] };
  route?: { path: string; methods: Record<string, boolean> };
};

// The routes the app really has, read from Express's own tables. Every router is mounted
// at /api or /api/auth (src/app.ts).
function appRoutes(): string[] {
  const routes: string[] = [];
  for (const layer of (app as unknown as { router: { stack: Layer[] } }).router.stack) {
    if (layer.name !== "router") continue;
    const prefix = layer.matchers[0]("/api/probe") ? "/api" : "/api/auth";
    for (const r of layer.handle.stack) {
      if (!r.route) continue;
      for (const method of Object.keys(r.route.methods)) routes.push(`${method.toUpperCase()} ${prefix}${r.route.path}`);
    }
  }
  return routes;
}

function call(route: string, cookie?: string) {
  const [method, path] = route.split(" ");
  const url = path.replace(/:id/g, "1").replace(/:slug/g, "sns-hostel");
  const req = request(app)[method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"](url);
  return cookie ? req.set("Cookie", `${SESSION_COOKIE}=${cookie}`) : req;
}

let owner: string;
let student: string;
let temporary: string;
beforeAll(async () => {
  owner = signSession({ userId: await insertOwner(db), role: "owner" }, SECRET);
  student = signSession({ userId: await insertStudent(db), role: "student" }, SECRET);
  temporary = signSession({ userId: await insertStudent(db, { mustChangePassword: true }), role: "student" }, SECRET);
});

const listed = Object.keys(ROUTES);
const guarded = listed.filter((r) => ROUTES[r].access !== "public");

describe("every API route has a guard", () => {
  it("lists exactly the routes the app has", () => {
    expect([...appRoutes()].sort()).toEqual([...listed].sort());
  });

  it.each(guarded)("%s refuses a caller who is not signed in", async (route) => {
    const res = await call(route);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it.each(guarded)("%s refuses a session signed with another secret", async (route) => {
    const forged = signSession({ userId: 1, role: "owner" }, "some-other-secret-that-is-32-characters");
    expect((await call(route, forged)).status).toBe(401);
  });

  it.each(guarded.filter((r) => ROUTES[r].access === "owner"))("%s refuses a student", async (route) => {
    const res = await call(route, student);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it.each(guarded.filter((r) => ROUTES[r].access === "student"))("%s refuses an owner", async (route) => {
    const res = await call(route, owner);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it.each(guarded.filter((r) => !ROUTES[r].temporary))(
    "%s waits until a temporary password is changed",
    async (route) => {
      const res = await call(route, temporary);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("password_change_required");
    },
  );

  it("runs the jobs only for the job secret", async () => {
    const none = await call("POST /api/internal/run-jobs");
    const wrong = await call("POST /api/internal/run-jobs").set("X-Job-Secret", "not-the-secret");
    for (const res of [none, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_job_secret");
    }
  });
});

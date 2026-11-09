import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hostelToday } from "../src/lib/dates";
import { signSession, type Role } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { inRollback, testPool } from "./helpers/db";
import { fillHostelB, rowsOfHostel, type HostelB } from "./helpers/hostels";
import { rollbackDb } from "./helpers/rollbackDb";

// Multi-tenant phase 2c: two hostels through the real routes. Two new hostels, A and B,
// each with one of everything (tests/helpers/hostels.ts), in one rolled-back transaction.
// Each owner and student signs in with a session cookie; the hostel comes from their
// account (requireAuth), never from the request. For each direction (A looking at B, and
// B at A):
//   - every list and count shows the viewer's own rows only;
//   - every route given one of the other hostel's ids answers 404, the same as a row that
//     does not exist, and nothing of the other hostel's changes.
// Before every request the transaction's hostel mark is cleared, as on the app's own pool,
// so a route that forgot withHostel fails here ("No hostel is set") instead of passing.
const db = testPool();
afterAll(() => db.end());

const SECRET = "test-secret-that-is-at-least-32-characters";
const TODAY = hostelToday();
const MONTH = TODAY.slice(0, 7);

type App = ReturnType<typeof createApp>;
type Method = "get" | "post" | "put" | "patch" | "delete";

const cookieFor = (userId: number, role: Role) => `${SESSION_COOKIE}=${signSession({ userId, role }, SECRET)}`;

// One request as `userId`, on a transaction with no hostel mark.
async function call(c: PoolClient, app: App, cookie: string, method: Method, path: string, body?: object) {
  await c.query("SET LOCAL app.hostel_id = ''");
  const req = request(app)[method](path).set("Cookie", cookie);
  return body === undefined ? req : req.send(body);
}

const ids = (items: { id: number }[]) => items.map((i) => i.id).sort((a, b) => a - b);

// Two fresh hostels and an app on the same transaction.
function withTwoHostels(fn: (ctx: { c: PoolClient; app: App; a: HostelB; b: HostelB }) => Promise<void>) {
  return inRollback(db, async (c) => {
    const a = await fillHostelB(c, "Hostel A");
    const b = await fillHostelB(c, "Hostel B");
    const app = createApp({ db: rollbackDb(c), jwtSecret: SECRET, clock: () => new Date() });
    await fn({ c, app, a, b });
  });
}

// What `me`'s owner and student see: their own hostel's rows, exactly.
async function expectOwnRowsOnly(c: PoolClient, app: App, me: HostelB) {
  const owner = cookieFor(me.owner, "owner");
  const student = cookieFor(me.student, "student");
  const get = async (cookie: string, path: string) => {
    const res = await call(c, app, cookie, "get", path);
    expect(res.status, path).toBe(200);
    return res.body;
  };

  expect((await get(owner, "/api/auth/me")).user.id).toBe(me.owner);
  expect(ids((await get(owner, "/api/structure")).buildings)).toEqual(ids([{ id: me.building }, { id: me.emptyBuilding }]));
  expect(ids((await get(owner, "/api/students?status=all&limit=50")).items)).toEqual(
    ids([{ id: me.student }, { id: me.former }, { id: me.quietFormer }]),
  );
  expect(ids((await get(owner, "/api/announcements")).items)).toEqual([me.announcement]);
  expect(ids((await get(owner, "/api/complaints")).items)).toEqual([me.complaint]);
  expect(ids((await get(owner, `/api/fees?month=${MONTH}`)).items)).toEqual([me.fee]);
  expect(ids((await get(owner, "/api/return-polls")).items)).toEqual([me.poll]);
  expect(ids((await get(owner, "/api/rejoin-requests")).items)).toEqual([me.rejoin]);
  expect((await get(owner, `/api/food-counts?date=${TODAY}`)).buildings.map((x: { buildingId: number }) => x.buildingId).sort())
    .toEqual([me.building, me.emptyBuilding].sort());
  const dashboard = await get(owner, "/api/dashboard");
  expect(dashboard.students.total).toBe(1);
  expect(dashboard.complaints.active).toBe(1);
  expect(dashboard.rejoinRequests.pending).toBe(1);
  expect(ids(dashboard.students.buildings)).toEqual(ids([{ id: me.building }, { id: me.emptyBuilding }]));

  expect(ids((await get(student, "/api/notifications")).items)).toEqual([me.notification]);
  expect(ids((await get(student, "/api/complaints")).items)).toEqual([me.complaint]);
  expect(ids((await get(student, "/api/fees/mine")).history)).toEqual([me.fee]);
  expect(ids((await get(student, "/api/return-polls")).items)).toEqual([me.poll]);
}

// Every route given one of `other`'s ids, as `me`'s owner or student: 404 each time.
async function expectOthersRowsRefused(c: PoolClient, app: App, me: HostelB, other: HostelB) {
  const owner = cookieFor(me.owner, "owner");
  const student = cookieFor(me.student, "student");
  const asOwner: [Method, string, object?][] = [
    ["get", `/api/students/${other.student}`],
    ["post", `/api/students/${other.student}/transfer`, { buildingId: me.building }],
    ["post", `/api/students/${other.student}/deactivate`],
    ["post", `/api/students/${other.student}/reset-password`],
    ["post", `/api/students/${other.former}/reactivate`, { joiningDate: TODAY, buildingId: me.building }],
    ["post", "/api/students", {
      name: "Asha Rao", email: `asha-${me.owner}-${other.owner}@test.local`, phone: "9876543210",
      parentPhone: "9876500000", category: "other", joiningDate: TODAY, foodPreference: "veg",
      monthlyFee: 6500, buildingId: other.building,
    }],
    ["post", `/api/buildings/${other.building}/floors`, { number: 5 }],
    ["post", `/api/buildings/${other.building}/rooms`, { roomNumber: "X1" }],
    ["post", `/api/rooms/${other.room}/beds`, { bedNumber: "Z" }],
    ["post", `/api/beds/${other.bed2}/retire`],
    ["post", `/api/beds/${other.bed2}/reactivate`],
    ["delete", `/api/buildings/${other.emptyBuilding}`],
    ["delete", `/api/floors/${other.spareFloor}`],
    ["delete", `/api/rooms/${other.spareRoom}`],
    ["patch", `/api/announcements/${other.announcement}`, { title: "Changed" }],
    ["delete", `/api/announcements/${other.announcement}`],
    ["get", `/api/complaints/${other.complaint}`],
    ["post", `/api/complaints/${other.complaint}/status`, { from: "open", to: "in_progress" }],
    ["patch", `/api/complaints/${other.complaint}`, { priority: "low" }],
    ["post", `/api/complaints/${other.complaint}/notes`, { note: "A note" }],
    ["post", `/api/fees/${other.fee}/status`, { status: "paid" }],
    ["get", `/api/return-polls/${other.poll}`],
    ["post", `/api/return-polls/${other.poll}/close`],
    ["post", `/api/rejoin-requests/${other.rejoin}/reject`],
    ["post", `/api/rejoin-requests/${other.rejoin}/approve`, { joiningDate: TODAY, buildingId: me.building }],
  ];
  const asStudent: [Method, string, object?][] = [
    ["get", `/api/complaints/${other.complaint}`],
    ["post", `/api/notifications/${other.notification}/read`],
    ["put", `/api/return-polls/${other.poll}/response`, { response: "returned" }],
  ];
  for (const [cookie, list] of [[owner, asOwner], [student, asStudent]] as const) {
    for (const [method, path, body] of list) {
      const res = await call(c, app, cookie, method, path, body);
      expect(res.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
  }
  // Marking every notification read touches only the student's own.
  expect((await call(c, app, student, "post", "/api/notifications/read-all")).status).toBe(200);
}

describe("two hostels through the routes", () => {
  it("shows each hostel's owner and student their own rows only", () =>
    withTwoHostels(async ({ c, app, a, b }) => {
      await expectOwnRowsOnly(c, app, a);
      await expectOwnRowsOnly(c, app, b);
    }));

  // About 60 requests, each signing in again: more than the default 5 seconds.
  it("answers 404 to each hostel for every one of the other's rows, and changes none of them", { timeout: 30_000 }, () =>
    withTwoHostels(async ({ c, app, a, b }) => {
      for (const [me, other] of [[a, b], [b, a]]) {
        const before = await rowsOfHostel(c, other.hostel);
        await expectOthersRowsRefused(c, app, me, other);
        expect(await rowsOfHostel(c, other.hostel)).toEqual(before);
      }
    }));

  // Payment details are each hostel's own (migration 017): saving one hostel's never
  // changes another's, and each owner and student reads their hostel's.
  it("keeps each hostel's payment details apart", () =>
    withTwoHostels(async ({ c, app, a, b }) => {
      const put = async (h: HostelB, upiId: string) => {
        const res = await call(c, app, cookieFor(h.owner, "owner"), "put", "/api/settings/payment", { upiId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      };
      const upiOf = async (h: HostelB) =>
        (await call(c, app, cookieFor(h.student, "student"), "get", "/api/settings/payment")).body.upiId;

      expect(await upiOf(a)).toBeNull();
      await put(a, "hostel-a@okaxis");
      await put(b, "hostel-b@ybl");
      expect(await upiOf(a)).toBe("hostel-a@okaxis");
      expect(await upiOf(b)).toBe("hostel-b@ybl");
      await put(a, "hostel-a2@okaxis");
      expect(await upiOf(b)).toBe("hostel-b@ybl");
    }));
});

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { getOwnerComplaint, listOwnerComplaints, type OwnerComplaintFilters } from "../src/services/complaints";
import { inRollback, insertOwner, insertStudent, testPool } from "./helpers/db";

// The owner's complaint list: listOwnerComplaints (you write it). The list covers every
// student, and other test files add complaints at the same time, so each test runs in a
// transaction that is rolled back, with one snapshot of the database (REPEATABLE READ),
// and looks at its own rows through a filter only it can match: its own building, or a
// date long before anything else is written.
const db = testPool();
afterAll(() => db.end());

const DESCRIPTION = "The tap in room 101 keeps dripping all night.";
const ITEM_FIELDS = [
  "category",
  "createdAt",
  "description",
  "id",
  "place",
  "priority",
  "resolvedAt",
  "status",
  "student",
  "updatedAt",
];

const NO_FILTERS: OwnerComplaintFilters = {
  status: null,
  priority: null,
  category: null,
  buildingId: null,
  from: null,
  to: null,
  page: 1,
  limit: 50,
};

const list = (c: PoolClient, f: Partial<OwnerComplaintFilters>) => listOwnerComplaints(c, { ...NO_FILTERS, ...f });
const ids = (r: { items: { id: number }[] }) => r.items.map((i) => i.id);

function inSnapshot(fn: (c: PoolClient) => Promise<void>) {
  return inRollback(db, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await fn(c);
  });
}

const one = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query<{ id: number }>(sql, params)).rows[0].id;

// A building of this test's own, with one room "101".
async function building(c: PoolClient) {
  const name = `Block ${Math.random()}`;
  const id = await one(c, "INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]);
  const room = await one(c, "INSERT INTO rooms (building_id, room_number) VALUES ($1, '101') RETURNING id", [id]);
  return { id, name, room };
}

// A student living in `now` (a building, optionally its room), or moved out when `now` is
// null. `before` gives an earlier, ended stay (a transfer, or the stay before moving out).
async function student(
  c: PoolClient,
  now: { building: number; room?: number } | null,
  opts: { name?: string; before?: number } = {},
) {
  const owner = await insertOwner(c);
  const id = await insertStudent(c, { isActive: now !== null });
  if (opts.name) await c.query("UPDATE users SET name = $2 WHERE id = $1", [id, opts.name]);
  const stay = (buildingId: number, room: number | null, startedOn: string, endedOn: string | null) =>
    c.query(
      `INSERT INTO stays (student_id, building_id, room_id, started_on, ended_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, buildingId, room, startedOn, endedOn, owner],
    );
  if (opts.before) await stay(opts.before, null, "2026-01-14", "2026-06-30");
  if (now) await stay(now.building, now.room ?? null, "2026-07-01", null);
  return id;
}

// A complaint written straight to the table. updated_at is created_at, and a resolved
// one was resolved an hour after it was raised.
async function complain(
  c: PoolClient,
  studentId: number,
  opts: { category?: string; status?: string; priority?: string; createdAt?: string } = {},
) {
  return one(
    c,
    `INSERT INTO complaints (student_id, category, description, status, priority, created_at, updated_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6,
             CASE WHEN $4 = 'resolved' THEN $6::timestamptz + interval '1 hour' END)
     RETURNING id`,
    [
      studentId,
      opts.category ?? "plumbing",
      DESCRIPTION,
      opts.status ?? "open",
      opts.priority ?? "normal",
      opts.createdAt ?? "2026-11-01T09:00:00+05:30",
    ],
  );
}

async function addEvent(
  c: PoolClient,
  complaint: number,
  actor: number,
  e: { kind: string; note?: string; from?: string; to?: string; at: string },
) {
  await c.query(
    `INSERT INTO complaint_events (complaint_id, actor_id, kind, note, from_status, to_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [complaint, actor, e.kind, e.note ?? null, e.from ?? null, e.to ?? null, e.at],
  );
}

describe("listOwnerComplaints: each row", () => {
  it("has exactly the owner's fields, with the student and where they live now", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const s = await student(c, { building: b.id, room: b.room }, { name: "Asha Rao" });
      const id = await complain(c, s, {
        category: "electrical",
        status: "resolved",
        priority: "high",
        createdAt: "2026-11-02T09:00:00+05:30",
      });

      const { items, total } = await list(c, { buildingId: b.id });

      expect(total).toBe(1);
      expect(Object.keys(items[0]).sort()).toEqual(ITEM_FIELDS);
      expect(items[0]).toEqual({
        id,
        category: "electrical",
        description: DESCRIPTION,
        status: "resolved",
        priority: "high",
        createdAt: new Date("2026-11-02T09:00:00+05:30"),
        updatedAt: new Date("2026-11-02T09:00:00+05:30"),
        resolvedAt: new Date("2026-11-02T10:00:00+05:30"),
        student: { id: s, name: "Asha Rao", isActive: true },
        place: { buildingName: b.name, roomNumber: "101" },
      });
    }));

  it("gives a null room for a student placed in a building only, and a null resolvedAt while open", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      await complain(c, await student(c, { building: b.id }));

      const { items } = await list(c, { buildingId: b.id });

      expect(items[0].place).toEqual({ buildingName: b.name, roomNumber: null });
      expect(items[0].resolvedAt).toBeNull();
    }));

  it("lists a moved-out student's complaint with no place, and the building filter never finds it", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const s = await student(c, null, { before: b.id });
      // A date nothing else writes, so the date filter finds this complaint alone.
      const id = await complain(c, s, { createdAt: "1971-03-15T09:00:00+05:30" });

      const byDate = await list(c, { from: "1971-03-15", to: "1971-03-15" });
      expect(ids(byDate)).toEqual([id]);
      expect(byDate.items[0].student).toEqual({ id: s, name: "Test Student", isActive: false });
      expect(byDate.items[0].place).toBeNull();

      expect(await list(c, { buildingId: b.id })).toEqual({ items: [], total: 0 });
    }));
});

describe("listOwnerComplaints: the order", () => {
  it("puts active first, then high, normal, low, then oldest first, ties by id", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const add = async (status: string, priority: string, day: string) =>
        complain(c, await student(c, { building: b.id }), {
          status,
          priority,
          createdAt: `2026-10-${day}T09:00:00+05:30`,
        });

      // Written in a mixed order, so the order cannot come from the ids alone.
      const rejectedLow = await add("rejected", "low", "01");
      const rejectedNormal = await add("rejected", "normal", "02");
      const openLow = await add("open", "low", "01"); // the oldest active: still after normal
      const openHigh = await add("open", "high", "06");
      const resolvedHigh = await add("resolved", "high", "05"); // high, but finished
      const inProgressNormal = await add("in_progress", "normal", "04");
      const inProgressHigh = await add("in_progress", "high", "03");
      const openHighSameTime = await add("open", "high", "06"); // same moment as openHigh

      const result = await list(c, { buildingId: b.id });

      expect(ids(result)).toEqual([
        inProgressHigh,
        openHigh,
        openHighSameTime,
        inProgressNormal,
        openLow,
        resolvedHigh,
        rejectedNormal,
        rejectedLow,
      ]);
      expect(result.total).toBe(8);
    }));
});

describe("listOwnerComplaints: filters", () => {
  it("filters by status, priority and category, alone and together", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const s = await student(c, { building: b.id });
      const t = await student(c, { building: b.id });
      const openHighFood = await complain(c, s, { status: "open", priority: "high", category: "food" });
      const progressNormalPlumbing = await complain(c, s, { status: "in_progress", category: "plumbing" });
      const resolvedLowFood = await complain(c, t, { status: "resolved", priority: "low", category: "food" });
      const rejectedHighInternet = await complain(c, t, { status: "rejected", priority: "high", category: "internet" });

      const only = (f: Partial<OwnerComplaintFilters>) => list(c, { buildingId: b.id, ...f });

      expect(ids(await only({ status: "open" }))).toEqual([openHighFood]);
      expect(ids(await only({ status: "in_progress" }))).toEqual([progressNormalPlumbing]);
      expect(ids(await only({ status: "resolved" }))).toEqual([resolvedLowFood]);
      expect(ids(await only({ status: "rejected" }))).toEqual([rejectedHighInternet]);

      expect(ids(await only({ priority: "high" }))).toEqual([openHighFood, rejectedHighInternet]);
      expect(ids(await only({ priority: "normal" }))).toEqual([progressNormalPlumbing]);
      expect(ids(await only({ priority: "low" }))).toEqual([resolvedLowFood]);

      expect(ids(await only({ category: "food" }))).toEqual([openHighFood, resolvedLowFood]);
      expect(ids(await only({ category: "internet" }))).toEqual([rejectedHighInternet]);
      expect(await only({ category: "electrical" })).toEqual({ items: [], total: 0 });

      const foodOpen = await only({ status: "open", category: "food" });
      expect(ids(foodOpen)).toEqual([openHighFood]);
      expect(foodOpen.total).toBe(1);
      expect(ids(await only({ priority: "high", category: "internet" }))).toEqual([rejectedHighInternet]);
      expect(await only({ status: "open", category: "plumbing" })).toEqual({ items: [], total: 0 });
    }));

  it("filters by the building the student lives in now, not where they lived when they complained", () =>
    inSnapshot(async (c) => {
      const a = await building(c);
      const b = await building(c);
      const inA = await complain(c, await student(c, { building: a.id }));
      // Lived in A, now in B (a transfer): found under B only.
      const movedToB = await complain(c, await student(c, { building: b.id }, { before: a.id }));

      expect(ids(await list(c, { buildingId: a.id }))).toEqual([inA]);
      const underB = await list(c, { buildingId: b.id });
      expect(ids(underB)).toEqual([movedToB]);
      expect(underB.items[0].place?.buildingName).toBe(b.name);
    }));

  it("filters by India's date, both ends included", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const add = async (createdAt: string) => complain(c, await student(c, { building: b.id }), { createdAt });
      const lateOct31 = await add("2026-10-31T23:50:00+05:30"); // 18:20 UTC, 31 Oct
      const earlyNov1 = await add("2026-11-01T00:10:00+05:30"); // 18:40 UTC, still 31 Oct in UTC
      const nov2 = await add("2026-11-02T12:00:00+05:30");

      const between = (from: string | null, to: string | null) => list(c, { buildingId: b.id, from, to });

      expect(ids(await between("2026-10-31", "2026-10-31"))).toEqual([lateOct31]);
      expect(ids(await between("2026-11-01", "2026-11-01"))).toEqual([earlyNov1]);
      expect(ids(await between("2026-11-01", null))).toEqual([earlyNov1, nov2]);
      expect(ids(await between(null, "2026-11-01"))).toEqual([lateOct31, earlyNov1]);
      expect(ids(await between("2026-10-31", "2026-11-02"))).toEqual([lateOct31, earlyNov1, nov2]);
      expect(await between("2026-11-03", null)).toEqual({ items: [], total: 0 });
      expect(await between(null, "2026-10-30")).toEqual({ items: [], total: 0 });
    }));
});

describe("listOwnerComplaints: pages and totals", () => {
  it("pages through the list in order, with the total on every page", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      for (const day of ["01", "02", "03", "04", "05"]) {
        await complain(c, await student(c, { building: b.id }), { createdAt: `2026-10-${day}T09:00:00+05:30` });
      }
      const all = ids(await list(c, { buildingId: b.id }));
      const page = (n: number) => list(c, { buildingId: b.id, page: n, limit: 2 });

      const pages = [await page(1), await page(2), await page(3), await page(4)];

      expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1, 0]);
      expect(pages.map((p) => p.total)).toEqual([5, 5, 5, 5]);
      expect(pages.flatMap((p) => ids(p))).toEqual(all);
    }));

  it("without filters, counts every complaint, every student's, moved-out ones included", () =>
    inSnapshot(async (c) => {
      const before = await list(c, {});
      await complain(c, await student(c, { building: (await building(c)).id }));
      await complain(c, await student(c, null));

      const after = await list(c, { limit: 5 });
      const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM complaints");

      expect(after.total).toBe(before.total + 2);
      expect(after.total).toBe(rows[0].n);
      expect(after.items.length).toBe(Math.min(5, after.total));
    }));
});

describe("getOwnerComplaint", () => {
  const EVENT_FIELDS = ["createdAt", "fromStatus", "kind", "note", "toStatus"];

  it("returns the list row, the whole timeline oldest first, and the moves allowed now", () =>
    inSnapshot(async (c) => {
      const b = await building(c);
      const s = await student(c, { building: b.id, room: b.room }, { name: "Ravi Kumar" });
      const owner = await insertOwner(c);
      const id = await complain(c, s, {
        category: "internet",
        status: "in_progress",
        priority: "high",
        createdAt: "2026-11-04T09:00:00+05:30",
      });
      // Written out of order, to show the order comes from the times.
      await addEvent(c, id, owner, { kind: "note", note: "Router ordered.", at: "2026-11-04T11:00:00+05:30" });
      await addEvent(c, id, s, { kind: "created", at: "2026-11-04T09:00:00+05:30" });
      await addEvent(c, id, owner, { kind: "status_change", from: "open", to: "in_progress", at: "2026-11-04T10:00:00+05:30" });

      const detail = await getOwnerComplaint(c, id);

      expect(Object.keys(detail).sort()).toEqual([...ITEM_FIELDS, "allowedMoves", "events"].sort());
      const { items } = await list(c, { buildingId: b.id });
      const { events, allowedMoves, ...row } = detail;
      expect(row).toEqual(items[0]);
      expect(row).toMatchObject({
        status: "in_progress",
        priority: "high",
        student: { id: s, name: "Ravi Kumar", isActive: true },
        place: { buildingName: b.name, roomNumber: "101" },
      });
      expect([...allowedMoves].sort()).toEqual(["rejected", "resolved"]);
      expect(events).toEqual([
        { kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: new Date("2026-11-04T09:00:00+05:30") },
        {
          kind: "status_change",
          note: null,
          fromStatus: "open",
          toStatus: "in_progress",
          createdAt: new Date("2026-11-04T10:00:00+05:30"),
        },
        { kind: "note", note: "Router ordered.", fromStatus: null, toStatus: null, createdAt: new Date("2026-11-04T11:00:00+05:30") },
      ]);
      for (const e of events) expect(Object.keys(e).sort()).toEqual(EVENT_FIELDS);
    }));

  it.each([
    ["open", ["in_progress", "rejected", "resolved"]],
    ["in_progress", ["rejected", "resolved"]],
    ["resolved", ["open"]],
    ["rejected", []],
  ])("allows from %s exactly the moves of the map", (status, moves) =>
    inSnapshot(async (c) => {
      const id = await complain(c, await student(c, { building: (await building(c)).id }), { status });
      expect([...(await getOwnerComplaint(c, id)).allowedMoves].sort()).toEqual(moves);
    }));

  it("shows a moved-out student's complaint with no place, and an empty timeline when there is none", () =>
    inSnapshot(async (c) => {
      const s = await student(c, null, { before: (await building(c)).id });
      const id = await complain(c, s);

      const detail = await getOwnerComplaint(c, id);

      expect(detail.student).toEqual({ id: s, name: "Test Student", isActive: false });
      expect(detail.place).toBeNull();
      expect(detail.events).toEqual([]);
    }));

  it("orders timeline entries at the same moment by id", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const id = await complain(c, await student(c, { building: (await building(c)).id }));
      const at = "2026-11-04T10:00:00+05:30";
      await addEvent(c, id, owner, { kind: "note", note: "First.", at });
      await addEvent(c, id, owner, { kind: "note", note: "Second.", at });

      expect((await getOwnerComplaint(c, id)).events.map((e) => e.note)).toEqual(["First.", "Second."]);
    }));

  it("refuses an id that does not exist with the student's 404", () =>
    inSnapshot(async (c) => {
      const err = await getOwnerComplaint(c, 999_999_999).then(
        () => {
          throw new Error("expected a refusal, but it succeeded");
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      const { status, code, message } = err as HttpError;
      expect({ status, code, message }).toEqual({
        status: 404,
        code: "complaint_not_found",
        message: "That complaint does not exist.",
      });
    }));
});

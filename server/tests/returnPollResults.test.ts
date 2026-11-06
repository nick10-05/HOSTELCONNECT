import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { getPollCounts, getPollResults, type PollResults } from "../src/services/returnPolls";
import { inSnapshot, insertOwner, testPool } from "./helpers/db";

// The return-poll results queries (day 9): who has returned, who has not yet, who has not
// answered, among the students active now. Other test files commit students at the same
// time, so every test runs in one rolled-back snapshot (the shared inSnapshot): lists
// filtered to the test's own building are exact, and unfiltered numbers are compared with
// a count taken inside the same snapshot. Polls are inserted closed (results do not care),
// so these tests never wait on another file's open poll.
const db = testPool();
afterAll(() => db.end());

const one = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query<{ id: number }>(sql, params)).rows[0].id;

async function newBuilding(c: PoolClient): Promise<{ id: number; name: string; room: number }> {
  const name = `Poll ${randomUUID()}`;
  const id = await one(c, "INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]);
  const room = await one(c, "INSERT INTO rooms (building_id, room_number) VALUES ($1, '204') RETURNING id", [id]);
  return { id, name, room };
}

type Who = { building: number; room?: number; active?: boolean; startedOn?: string };

// A student called `name` with one stay: current (or ended, when not active) in `building`.
async function student(c: PoolClient, name: string, who: Who): Promise<number> {
  const owner = await insertOwner(c);
  const active = who.active ?? true;
  const id = await one(
    c,
    `INSERT INTO users (role, name, email, password_hash, must_change_password, is_active,
                        phone, parent_phone, category, joining_date, food_preference)
     VALUES ('student', $1, $2, 'not-a-real-hash', false, $3,
             '9000000000', '9000000001', 'other', '2026-01-14', 'veg') RETURNING id`,
    [name, `poll-${randomUUID()}@test.local`, active],
  );
  await c.query(
    `INSERT INTO stays (student_id, building_id, room_id, started_on, ended_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, who.building, who.room ?? null, who.startedOn ?? "2026-01-14", active ? null : "2026-10-01", owner],
  );
  return id;
}

async function closedPoll(c: PoolClient, title = "Back after Diwali?"): Promise<number> {
  const owner = await insertOwner(c);
  return one(
    c,
    `INSERT INTO return_polls (title, created_by, status, closed_at) VALUES ($1, $2, 'closed', now()) RETURNING id`,
    [title, owner],
  );
}

async function answer(c: PoolClient, poll: number, studentId: number, response: "returned" | "not_yet") {
  await c.query(`INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, $3)`, [
    poll,
    studentId,
    response,
  ]);
}

const activeStudents = async (c: PoolClient) =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_active`))
    .rows[0].n;

const ids = (list: { studentId: number }[]) => list.map((s) => s.studentId);

describe("getPollResults", () => {
  it("lists returned, not yet and no response for one building, with counts", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const back = await student(c, "Asha", { building: b.id, room: b.room });
      const notYet = await student(c, "Bilal", { building: b.id });
      const silent = await student(c, "Chitra", { building: b.id, room: b.room });
      const poll = await closedPoll(c);
      await answer(c, poll, back, "returned");
      await answer(c, poll, notYet, "not_yet");

      const r = await getPollResults(c, poll, b.id);

      expect(r.poll).toEqual({
        id: poll,
        title: "Back after Diwali?",
        status: "closed",
        createdAt: expect.any(Date),
        closedAt: expect.any(Date),
      });
      expect(r.counts).toEqual({ returned: 1, notYet: 1, noResponse: 1 });
      expect(r.returned).toEqual([
        { studentId: back, name: "Asha", buildingId: b.id, buildingName: b.name, roomNumber: "204", respondedAt: expect.any(Date) },
      ]);
      expect(r.notYet).toEqual([
        { studentId: notYet, name: "Bilal", buildingId: b.id, buildingName: b.name, roomNumber: null, respondedAt: expect.any(Date) },
      ]);
      expect(r.noResponse).toEqual([
        { studentId: silent, name: "Chitra", buildingId: b.id, buildingName: b.name, roomNumber: "204" },
      ]);
    }));

  it("works the same for an open poll", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const s = await student(c, "Asha", { building: b.id });
      // The open poll another file may hold makes this insert wait for it, never fail:
      // that file's transaction is rolled back too.
      const owner = await insertOwner(c);
      const poll = await one(c, `INSERT INTO return_polls (title, created_by) VALUES ('Open one', $1) RETURNING id`, [owner]);
      await answer(c, poll, s, "returned");

      const r = await getPollResults(c, poll, b.id);
      expect(r.poll).toMatchObject({ id: poll, status: "open", closedAt: null });
      expect(ids(r.returned)).toEqual([s]);
    }));

  it("leaves out moved-out students, even if they answered, and never lists the owner", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const stayed = await student(c, "Asha", { building: b.id });
      const left = await student(c, "Bilal", { building: b.id, active: false });
      const leftSilent = await student(c, "Chitra", { building: b.id, active: false });
      const poll = await closedPoll(c);
      await answer(c, poll, stayed, "not_yet");
      await answer(c, poll, left, "returned");

      const r = await getPollResults(c, poll, b.id);
      expect(r.counts).toEqual({ returned: 0, notYet: 1, noResponse: 0 });
      expect(ids(r.notYet)).toEqual([stayed]);

      const all = await getPollResults(c, poll);
      const everyone = [...ids(all.returned), ...ids(all.notYet), ...ids(all.noResponse)];
      expect(everyone).not.toContain(left);
      expect(everyone).not.toContain(leftSilent);
      const owners = (await c.query<{ id: number }>(`SELECT id FROM users WHERE role = 'owner'`)).rows.map((o) => o.id);
      expect(everyone.filter((id) => owners.includes(id))).toEqual([]);
    }));

  it("counts a student whose stay starts later as no response", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const later = await student(c, "Asha", { building: b.id, startedOn: "2099-01-01" });
      const poll = await closedPoll(c);
      const r = await getPollResults(c, poll, b.id);
      expect(ids(r.noResponse)).toEqual([later]);
    }));

  it("counts only answers to this poll", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const s = await student(c, "Asha", { building: b.id });
      const poll = await closedPoll(c, "This one");
      const other = await closedPoll(c, "Another one");
      await answer(c, other, s, "returned");

      const r = await getPollResults(c, poll, b.id);
      expect(r.counts).toEqual({ returned: 0, notYet: 0, noResponse: 1 });
      expect(ids(r.noResponse)).toEqual([s]);
    }));

  it("places a student by their current stay only, after a move between buildings", () =>
    inSnapshot(db, async (c) => {
      const from = await newBuilding(c);
      const to = await newBuilding(c);
      const s = await student(c, "Asha", { building: to.id, room: to.room });
      const owner = await insertOwner(c);
      await c.query(
        `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by)
         VALUES ($1, $2, '2025-06-01', '2026-01-14', $3)`,
        [s, from.id, owner],
      );
      const poll = await closedPoll(c);
      await answer(c, poll, s, "returned");

      expect((await getPollResults(c, poll, from.id)).counts).toEqual({ returned: 0, notYet: 0, noResponse: 0 });
      const r = await getPollResults(c, poll, to.id);
      expect(r.returned).toEqual([
        expect.objectContaining({ studentId: s, buildingId: to.id, buildingName: to.name, roomNumber: "204" }),
      ]);
    }));

  it("orders each list by name ignoring case, then id", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const bob = await student(c, "bob", { building: b.id });
      const alice1 = await student(c, "alice", { building: b.id });
      const alice2 = await student(c, "Alice", { building: b.id });
      const zara = await student(c, "Zara", { building: b.id });
      const poll = await closedPoll(c);
      for (const s of [zara, bob, alice2, alice1]) await answer(c, poll, s, "returned");

      const r = await getPollResults(c, poll, b.id);
      expect(ids(r.returned)).toEqual([alice1, alice2, bob, zara]);
      expect(ids((await getPollResults(c, await closedPoll(c), b.id)).noResponse)).toEqual([alice1, alice2, bob, zara]);
    }));

  it("gives empty lists and zero counts for an unknown building", () =>
    inSnapshot(db, async (c) => {
      const poll = await closedPoll(c);
      const r = await getPollResults(c, poll, 999_999_999);
      expect(r).toEqual({
        poll: expect.objectContaining({ id: poll }),
        counts: { returned: 0, notYet: 0, noResponse: 0 },
        returned: [],
        notYet: [],
        noResponse: [],
      });
    }));

  it("covers every active student without a building filter", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const back = await student(c, "Asha", { building: b.id });
      const silent = await student(c, "Bilal", { building: b.id });
      const poll = await closedPoll(c);
      await answer(c, poll, back, "returned");

      const r: PollResults = await getPollResults(c, poll);
      const total = await activeStudents(c);
      expect(r.counts).toEqual({ returned: 1, notYet: 0, noResponse: total - 1 });
      expect(r.noResponse).toHaveLength(total - 1);
      expect(ids(r.returned)).toEqual([back]);
      expect(ids(r.noResponse)).toContain(silent);
    }));

  it("refuses an unknown poll with 404", () =>
    inSnapshot(db, async (c) => {
      await expect(getPollResults(c, 999_999_999)).rejects.toMatchObject({ status: 404, code: "poll_not_found" });
    }));
});

describe("getPollCounts", () => {
  it("gives each poll's counts, agreeing with getPollResults", () =>
    inSnapshot(db, async (c) => {
      const b = await newBuilding(c);
      const s1 = await student(c, "Asha", { building: b.id });
      const s2 = await student(c, "Bilal", { building: b.id });
      const left = await student(c, "Chitra", { building: b.id, active: false });
      const first = await closedPoll(c, "First");
      const second = await closedPoll(c, "Second");
      await answer(c, first, s1, "returned");
      await answer(c, first, s2, "not_yet");
      await answer(c, first, left, "returned");
      await answer(c, second, s2, "returned");

      const counts = await getPollCounts(c, [first, second]);
      const total = await activeStudents(c);
      expect(counts).toEqual(
        new Map([
          [first, { returned: 1, notYet: 1, noResponse: total - 2 }],
          [second, { returned: 1, notYet: 0, noResponse: total - 1 }],
        ]),
      );
      for (const poll of [first, second]) {
        expect(counts.get(poll)).toEqual((await getPollResults(c, poll)).counts);
      }
    }));

  it("gives a poll nobody answered every active student as no response", () =>
    inSnapshot(db, async (c) => {
      const poll = await closedPoll(c);
      const total = await activeStudents(c);
      expect(await getPollCounts(c, [poll])).toEqual(new Map([[poll, { returned: 0, notYet: 0, noResponse: total }]]));
    }));

  it("leaves out ids that are not polls, and needs no query for none", () =>
    inSnapshot(db, async (c) => {
      const poll = await closedPoll(c);
      const counts = await getPollCounts(c, [poll, 999_999_999]);
      expect([...counts.keys()]).toEqual([poll]);

      const noDatabase = { query: () => Promise.reject(new Error("no query expected")) };
      expect(await getPollCounts(noDatabase as unknown as PoolClient, [])).toEqual(new Map());
    }));
});

import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Queryable } from "../src/db";
import { HttpError } from "../src/lib/http";
import {
  answerPollInTransaction,
  closePoll,
  createPollInTransaction,
  getPollCounts,
  listOpenPollsForStudent,
  listPolls,
  RETURN_POLL_LINK,
  returnPollKey,
} from "../src/services/returnPolls";
import { inSnapshot as inSharedSnapshot, insertOwner, insertStudent, testPool } from "./helpers/db";

// Starting, closing and answering return polls, and the two lists (day 9, Claude).
// Starting a poll notifies EVERY active student, including other test files' students, so
// every test runs inside a transaction that is rolled back, with one snapshot of the
// database (the shared inSnapshot): counts of "every active student" are taken in it.
// At most one poll is open: another file opening one at the same moment makes an insert
// here wait for that file's transaction to end (it is rolled back too), never fail.
//
// Not tested here: two requests racing to open a poll, and an answer racing a close. Both
// need a committed open poll, which would break other files' tests while it exists. The
// first is covered by translating the index's refusal (a fake database below); the second
// rests on Postgres row locks (FOR SHARE against UPDATE), as the service comment explains.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const TITLE = "Back after Diwali?";

const inSnapshot = (fn: (c: PoolClient) => Promise<void>) => inSharedSnapshot(db, fn);

const count = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(sql, params)).rows[0].n;

const activeStudents = (c: PoolClient) =>
  count(c, "SELECT count(*)::int AS n FROM users WHERE role = 'student' AND is_active");

const bellOf = async (c: PoolClient, userId: number) =>
  (
    await c.query(
      `SELECT type, title, body, link, dedup_key AS "dedupKey", read_at AS "readAt"
       FROM notifications WHERE user_id = $1 ORDER BY id`,
      [userId],
    )
  ).rows;

async function refusal(call: Promise<unknown>) {
  const err = await call.then(
    () => {
      throw new Error("expected a refusal, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  const { status, code, message } = err as HttpError;
  return { status, code, message };
}

const NOT_FOUND = { status: 404, code: "poll_not_found", message: "That poll does not exist." };
const CLOSED = { status: 409, code: "poll_closed", message: "That poll is closed." };
const ALREADY_OPEN = {
  status: 409,
  code: "poll_already_open",
  message: "A return poll is already open. Close it before starting another.",
};

// A poll written straight to the table, without notifying anyone.
async function addPoll(c: PoolClient, opts: { open?: boolean; title?: string } = {}): Promise<number> {
  const owner = await insertOwner(c);
  const { rows } = await c.query<{ id: number }>(
    opts.open
      ? `INSERT INTO return_polls (title, created_by) VALUES ($1, $2) RETURNING id`
      : `INSERT INTO return_polls (title, created_by, status, closed_at) VALUES ($1, $2, 'closed', now()) RETURNING id`,
    [opts.title ?? TITLE, owner],
  );
  return rows[0].id;
}

const answersOf = async (c: PoolClient, poll: number) =>
  (
    await c.query(
      `SELECT student_id AS "studentId", response, responded_at = now() AS "answeredNow"
       FROM return_poll_responses WHERE poll_id = $1 ORDER BY student_id`,
      [poll],
    )
  ).rows;

describe("createPollInTransaction", () => {
  it("starts an open poll and returns it", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const poll = await createPollInTransaction(c, owner, TITLE);

      expect(poll).toEqual({ id: expect.any(Number), title: TITLE, status: "open", createdAt: expect.any(Date), closedAt: null });
      const { rows } = await c.query(`SELECT title, status, created_by FROM return_polls WHERE id = $1`, [poll.id]);
      expect(rows).toEqual([{ title: TITLE, status: "open", created_by: owner }]);
    }));

  it("notifies every active student once, with fixed text, and nobody else", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      const movedOut = await insertStudent(c, { isActive: false });

      const poll = await createPollInTransaction(c, owner, "Back after Diwali? Call 9876543210");

      const key = returnPollKey(poll.id);
      expect(key).toBe(`return_poll:${poll.id}`);
      expect(await count(c, "SELECT count(*)::int AS n FROM notifications WHERE dedup_key = $1", [key])).toBe(
        await activeStudents(c),
      );
      expect(await bellOf(c, student)).toEqual([
        { type: "return_poll", title: "New return poll from the hostel.", body: null, link: "/", dedupKey: key, readAt: null },
      ]);
      expect(RETURN_POLL_LINK).toBe("/");
      expect(await bellOf(c, movedOut)).toEqual([]);
      expect(await bellOf(c, owner)).toEqual([]);
    }));

  it("refuses a second open poll, writing nothing", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const student = await insertStudent(c);
      await createPollInTransaction(c, owner, TITLE);
      const polls = await count(c, "SELECT count(*)::int AS n FROM return_polls");

      expect(await refusal(createPollInTransaction(c, owner, "Another one"))).toEqual(ALREADY_OPEN);
      expect(await count(c, "SELECT count(*)::int AS n FROM return_polls")).toBe(polls);
      expect(await bellOf(c, student)).toHaveLength(1);
    }));

  it("starts a new poll once the open one is closed", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const first = await createPollInTransaction(c, owner, TITLE);
      await closePoll(c, first.id);
      const second = await createPollInTransaction(c, owner, "Back after Holi?");
      expect(second).toMatchObject({ status: "open", title: "Back after Holi?" });
    }));

  // The race: two requests both find no open poll, and the index refuses the second insert.
  it("turns the one-open index's refusal into the same 409", async () => {
    const raceLost: Queryable = {
      query: (async (sql: string) => {
        if (/INSERT INTO return_polls/i.test(sql)) {
          throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "return_polls_one_open" });
        }
        return { rows: [], rowCount: 0 };
      }) as unknown as Queryable["query"],
    };
    expect(await refusal(createPollInTransaction(raceLost, 1, TITLE))).toEqual(ALREADY_OPEN);
  });

  it("passes any other database error on unchanged", async () => {
    const broken = new Error("connection lost");
    const failing: Queryable = {
      query: (async (sql: string) => {
        if (/INSERT INTO return_polls/i.test(sql)) throw broken;
        return { rows: [], rowCount: 0 };
      }) as unknown as Queryable["query"],
    };
    await expect(createPollInTransaction(failing, 1, TITLE)).rejects.toBe(broken);
  });
});

describe("closePoll", () => {
  it("closes an open poll and returns it, notifying nobody", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const poll = await addPoll(c, { open: true });

      const closed = await closePoll(c, poll);

      expect(closed).toEqual({ id: poll, title: TITLE, status: "closed", createdAt: expect.any(Date), closedAt: expect.any(Date) });
      const { rows } = await c.query(`SELECT status, closed_at = now() AS "closedNow" FROM return_polls WHERE id = $1`, [poll]);
      expect(rows).toEqual([{ status: "closed", closedNow: true }]);
      expect(await bellOf(c, student)).toEqual([]);
    }));

  it("refuses a poll that is already closed, and one that does not exist", () =>
    inSnapshot(async (c) => {
      const poll = await addPoll(c);
      const before = (await c.query(`SELECT closed_at FROM return_polls WHERE id = $1`, [poll])).rows;
      expect(await refusal(closePoll(c, poll))).toEqual(CLOSED);
      expect((await c.query(`SELECT closed_at FROM return_polls WHERE id = $1`, [poll])).rows).toEqual(before);
      expect(await refusal(closePoll(c, MISSING))).toEqual(NOT_FOUND);
    }));
});

describe("answerPollInTransaction", () => {
  it("records a first answer and returns it", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const poll = await addPoll(c, { open: true });

      const answer = await answerPollInTransaction(c, poll, student, "returned");

      expect(answer).toEqual({ pollId: poll, response: "returned", respondedAt: expect.any(Date) });
      expect(await answersOf(c, poll)).toEqual([{ studentId: student, response: "returned", answeredNow: true }]);
    }));

  it("replaces an earlier answer while the poll is open, keeping one row", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const poll = await addPoll(c, { open: true });
      await c.query(
        `INSERT INTO return_poll_responses (poll_id, student_id, response, responded_at)
         VALUES ($1, $2, 'not_yet', now() - interval '2 days')`,
        [poll, student],
      );

      await answerPollInTransaction(c, poll, student, "returned");

      expect(await answersOf(c, poll)).toEqual([{ studentId: student, response: "returned", answeredNow: true }]);
    }));

  it("keeps each student's answer separate", () =>
    inSnapshot(async (c) => {
      const a = await insertStudent(c);
      const b = await insertStudent(c);
      const poll = await addPoll(c, { open: true });
      await answerPollInTransaction(c, poll, a, "returned");
      await answerPollInTransaction(c, poll, b, "not_yet");
      expect((await answersOf(c, poll)).map((r) => [r.studentId, r.response])).toEqual(
        [
          [a, "returned"],
          [b, "not_yet"],
        ].sort((x, y) => (x[0] as number) - (y[0] as number)),
      );
    }));

  it("refuses a closed poll and one that does not exist, writing nothing", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const poll = await addPoll(c);
      expect(await refusal(answerPollInTransaction(c, poll, student, "returned"))).toEqual(CLOSED);
      expect(await answersOf(c, poll)).toEqual([]);
      expect(await refusal(answerPollInTransaction(c, MISSING, student, "returned"))).toEqual(NOT_FOUND);
    }));

  it("keeps an earlier answer unchanged once the poll is closed", () =>
    inSnapshot(async (c) => {
      const student = await insertStudent(c);
      const poll = await addPoll(c, { open: true });
      await answerPollInTransaction(c, poll, student, "not_yet");
      await closePoll(c, poll);
      expect(await refusal(answerPollInTransaction(c, poll, student, "returned"))).toEqual(CLOSED);
      expect((await answersOf(c, poll)).map((r) => r.response)).toEqual(["not_yet"]);
    }));
});

describe("listPolls", () => {
  it("lists every poll newest first, with counts and the total", () =>
    inSnapshot(async (c) => {
      const before = await listPolls(c, { page: 1, limit: 50 });
      const student = await insertStudent(c);
      const older = await addPoll(c, { title: "Back after Dussehra?" }); // closed
      const newer = await addPoll(c, { open: true });
      await answerPollInTransaction(c, newer, student, "returned");

      const { items, total } = await listPolls(c, { page: 1, limit: 2 });

      expect(total).toBe(before.total + 2);
      // Same created_at (one transaction), so the higher id is newer.
      expect(items.map((p) => p.id)).toEqual([newer, older]);
      expect(items[0]).toEqual({
        id: newer,
        title: TITLE,
        status: "open",
        createdAt: expect.any(Date),
        closedAt: null,
        counts: (await getPollCounts(c, [newer])).get(newer),
      });
      expect(items[0].counts.returned).toBe(1);
      expect(items[1]).toMatchObject({ id: older, status: "closed", title: "Back after Dussehra?" });
    }));

  it("orders by creation time before id, and pages", () =>
    inSnapshot(async (c) => {
      const owner = await insertOwner(c);
      const insert = async (at: string) =>
        (
          await c.query<{ id: number }>(
            `INSERT INTO return_polls (title, created_by, status, created_at, closed_at)
             VALUES ('Old poll', $1, 'closed', $2, $2) RETURNING id`,
            [owner, at],
          )
        ).rows[0].id;
      // Far in the future, so they come before every other file's polls.
      const late = await insert("2099-03-01T00:00:00Z");
      const early = await insert("2099-01-01T00:00:00Z");
      const middle = await insert("2099-02-01T00:00:00Z");

      expect((await listPolls(c, { page: 1, limit: 2 })).items.map((p) => p.id)).toEqual([late, middle]);
      expect((await listPolls(c, { page: 2, limit: 2 })).items[0].id).toBe(early);
      const { total } = await listPolls(c, { page: 1, limit: 1 });
      expect((await listPolls(c, { page: total + 1, limit: 1 })).items).toEqual([]);
    }));
});

describe("listOpenPollsForStudent", () => {
  it("shows the open poll with the student's own answer, or none yet", () =>
    inSnapshot(async (c) => {
      const me = await insertStudent(c);
      const other = await insertStudent(c);
      const open = await addPoll(c, { open: true });
      await answerPollInTransaction(c, open, other, "returned");

      expect(await listOpenPollsForStudent(c, me)).toEqual([
        { id: open, title: TITLE, createdAt: expect.any(Date), myResponse: null, respondedAt: null },
      ]);

      await answerPollInTransaction(c, open, me, "not_yet");
      expect(await listOpenPollsForStudent(c, me)).toEqual([
        { id: open, title: TITLE, createdAt: expect.any(Date), myResponse: "not_yet", respondedAt: expect.any(Date) },
      ]);
    }));

  it("leaves out closed polls, even ones the student answered", () =>
    inSnapshot(async (c) => {
      const me = await insertStudent(c);
      const closed = await addPoll(c, { open: true });
      await answerPollInTransaction(c, closed, me, "returned");
      await closePoll(c, closed);
      await addPoll(c);

      expect((await listOpenPollsForStudent(c, me)).map((p) => p.id)).not.toContain(closed);
      expect(await listOpenPollsForStudent(c, me)).toEqual([]);
    }));
});

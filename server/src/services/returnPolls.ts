import type { PoolClient } from "pg";
import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { notify } from "./notifications";

// Return polls: an occasional "who is back?" after a holiday (design doc, sections 3, 5
// and 9). Day 9. tests/returnPollResults.test.ts describes the results queries;
// tests/returnPolls.test.ts the rest.
//
// Locking: nothing here locks a student's users row. The fan-out's notification rows take
// only share locks on the students' rows (their foreign key), as an announcement's do.
// Answering reads the poll row FOR SHARE and closing updates it, so an answer and a close
// never overlap: whichever comes second waits, then sees the other's result.
//
// Who a poll covers (section 3, decided on day 9): every student who is active now, read
// live. "No response" is an active student with no answer row; a student who moves out
// drops off every poll's lists and counts, closed polls included, and the owner is never
// in them. Answers from students who are no longer active are kept but not shown.

export type PollStatus = "open" | "closed";

// One poll, as the owner sees it. Times are timestamps (Date).
export type ReturnPoll = {
  id: number;
  title: string;
  status: PollStatus;
  createdAt: Date;
  closedAt: Date | null;
};

export type PollCounts = { returned: number; notYet: number; noResponse: number };

// A student in a results list, with where they live now: the building and room of their
// current stay (ended_on IS NULL). An active student always has one; the fields are NULL
// only if the data says otherwise. A room is optional (section 3). No phone numbers: the
// owner opens the student's profile for those.
export type PollStudent = {
  studentId: number;
  name: string;
  buildingId: number | null;
  buildingName: string | null;
  roomNumber: string | null;
};
export type PollAnswer = PollStudent & { respondedAt: Date };

export type PollResults = {
  poll: ReturnPoll;
  counts: PollCounts;
  returned: PollAnswer[];
  notYet: PollAnswer[];
  noResponse: PollStudent[];
};

// Exactly ReturnPoll's fields.
const POLL_COLUMNS = `id, title, status, created_at AS "createdAt", closed_at AS "closedAt"`;

export const POLL_NOT_FOUND = () => new HttpError(404, "poll_not_found", "That poll does not exist.");

// ---- Results (section 12 lists these under "You write"; Claude writes them at Nikhil's
// request, stub, contract and tests first) ----

// GET /api/return-polls/:id: one poll (open or closed) and who has returned, who has not
// yet, and who has not answered.
//   returned / notYet  active students who answered 'returned' / 'not_yet' to this poll,
//                      each with respondedAt
//   noResponse         active students with no answer to this poll, whether or not they
//                      answered another poll; a student whose stay starts later counts
//   counts             the three lists' lengths
// With `buildingId`, only students whose current stay is in that building, in all three
// lists and the counts; an unknown building gives empty lists and zero counts (not an
// error). Without it, every active student.
// Each list is ordered by name ignoring case (lower(name)), then id.
// Read-only, outside a transaction.
//   404 poll_not_found  "That poll does not exist."
export async function getPollResults(
  db: Queryable,
  pollId: number,
  buildingId: number | null = null,
): Promise<PollResults> {
  const { rows: polls } = await db.query<ReturnPoll>(
    `SELECT ${POLL_COLUMNS} FROM return_polls WHERE id = $1`,
    [pollId],
  );
  if (polls.length === 0) throw POLL_NOT_FOUND();

  // Every active student, once each (one current stay at most: a partial unique index),
  // with where they live now and their answer to this poll, if any. The building filter
  // is on the current stay, so an old stay in that building never counts.
  const { rows } = await db.query<PollStudent & { response: "returned" | "not_yet" | null; respondedAt: Date | null }>(
    `SELECT u.id AS "studentId", u.name,
            s.building_id AS "buildingId", b.name AS "buildingName", r.room_number AS "roomNumber",
            a.response, a.responded_at AS "respondedAt"
     FROM users u
     LEFT JOIN stays s ON s.student_id = u.id AND s.ended_on IS NULL
     LEFT JOIN buildings b ON b.id = s.building_id
     LEFT JOIN rooms r ON r.id = s.room_id
     LEFT JOIN return_poll_responses a ON a.poll_id = $1 AND a.student_id = u.id
     WHERE u.role = 'student' AND u.is_active
       AND ($2::bigint IS NULL OR s.building_id = $2)
     ORDER BY lower(u.name), u.id`,
    [pollId, buildingId],
  );

  // Split in that order, so each list keeps it.
  const returned: PollAnswer[] = [];
  const notYet: PollAnswer[] = [];
  const noResponse: PollStudent[] = [];
  for (const { response, respondedAt, ...who } of rows) {
    if (response === "returned") returned.push({ ...who, respondedAt: respondedAt! });
    else if (response === "not_yet") notYet.push({ ...who, respondedAt: respondedAt! });
    else noResponse.push(who);
  }

  return {
    poll: polls[0],
    counts: { returned: returned.length, notYet: notYet.length, noResponse: noResponse.length },
    returned,
    notYet,
    noResponse,
  };
}

// The counts of several polls at once, for the owner's poll list and the dashboard card:
// a Map from poll id to its counts, by the same rule as getPollResults with no building
// filter, so the two always agree. Ids that are not polls are left out of the Map; an
// empty list gives an empty Map without asking the database. Read-only.
export async function getPollCounts(db: Queryable, pollIds: number[]): Promise<Map<number, PollCounts>> {
  if (pollIds.length === 0) return new Map();

  // Each poll against every active student. LEFT JOINs, so a poll still has a row (all
  // zeros) when there are no active students; u.id IS NULL then, and counts as nobody.
  const { rows } = await db.query<PollCounts & { pollId: number }>(
    `SELECT p.id AS "pollId",
            count(*) FILTER (WHERE a.response = 'returned')::int AS returned,
            count(*) FILTER (WHERE a.response = 'not_yet')::int AS "notYet",
            count(u.id) FILTER (WHERE a.response IS NULL)::int AS "noResponse"
     FROM return_polls p
     LEFT JOIN users u ON u.role = 'student' AND u.is_active
     LEFT JOIN return_poll_responses a ON a.poll_id = p.id AND a.student_id = u.id
     WHERE p.id = ANY ($1::bigint[])
     GROUP BY p.id`,
    [pollIds],
  );
  return new Map(rows.map(({ pollId, ...counts }) => [pollId, counts]));
}

// ---- Starting, closing and answering (Claude) ----

export type PollResponse = "returned" | "not_yet";

// Where a poll's notification takes a student: their home page, where the open poll's
// two buttons are.
export const RETURN_POLL_LINK = "/";

// The dedup key of a poll's notifications, so a student is told about one poll once.
export const returnPollKey = (id: number) => `return_poll:${id}`;

const POLL_ALREADY_OPEN = () =>
  new HttpError(409, "poll_already_open", "A return poll is already open. Close it before starting another.");
const POLL_CLOSED = () => new HttpError(409, "poll_closed", "That poll is closed.");

// Inside the caller's transaction: starts a poll titled `title` (the route trims it and
// checks 1 to 120 characters, as migration 012 does) by `ownerId`, and notifies every
// active student with notify(c, "active_students", ...):
//   type       'return_poll'
//   title      "New return poll from the hostel."
//   body       null
//   link       RETURN_POLL_LINK ("/")
//   dedupKey   returnPollKey(<the new id>)
// Like an announcement's, the notification never repeats the owner's text.
// Only one poll may be open (decided on day 9):
//   409 poll_already_open  "A return poll is already open. Close it before starting another."
// both when an open poll is already there and when another request opens one at the same
// moment (return_polls_one_open refuses the insert; that refusal becomes the same 409).
// Returns the new poll.
export async function createPollInTransaction(c: Queryable, ownerId: number, title: string): Promise<ReturnPoll> {
  // The usual case: an open poll is already there.
  const { rowCount } = await c.query(`SELECT 1 FROM return_polls WHERE status = 'open' LIMIT 1`);
  if (rowCount) throw POLL_ALREADY_OPEN();

  // The race: another request opened one after the check. The index refuses this insert.
  let poll: ReturnPoll;
  try {
    const { rows } = await c.query<ReturnPoll>(
      `INSERT INTO return_polls (title, created_by) VALUES ($1, $2) RETURNING ${POLL_COLUMNS}`,
      [title, ownerId],
    );
    poll = rows[0];
  } catch (err) {
    const { code, constraint } = err as { code?: string; constraint?: string };
    if (code === "23505" && constraint === "return_polls_one_open") throw POLL_ALREADY_OPEN();
    throw err;
  }

  // One notification per active student. Fixed text: never the owner's own words.
  await notify(c, "active_students", {
    type: "return_poll",
    title: "New return poll from the hostel.",
    body: null,
    link: RETURN_POLL_LINK,
    dedupKey: returnPollKey(poll.id),
  });

  return poll;
}

// Starts a poll, all or nothing: the core above in one transaction.
export async function createPoll(db: Db, ownerId: number, title: string): Promise<ReturnPoll> {
  return inTransaction(db, (c) => createPollInTransaction(c, ownerId, title));
}

// Closes an open poll: status 'closed', closed_at now. Closing is final (decided on day 9);
// nobody is notified. Results stay readable; answers can no longer change.
//   404 poll_not_found  "That poll does not exist."
//   409 poll_closed     "That poll is closed."   (already closed)
// Returns the closed poll.
export async function closePoll(db: Queryable, pollId: number): Promise<ReturnPoll> {
  // One statement: two closes at once cannot both succeed (the second finds it closed).
  const { rows } = await db.query<ReturnPoll>(
    `UPDATE return_polls SET status = 'closed', closed_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING ${POLL_COLUMNS}`,
    [pollId],
  );
  if (rows.length > 0) return rows[0];

  // Nothing closed: say why.
  const { rowCount } = await db.query(`SELECT 1 FROM return_polls WHERE id = $1`, [pollId]);
  throw rowCount ? POLL_CLOSED() : POLL_NOT_FOUND();
}

// The student's answer, as stored.
export type MyAnswer = { pollId: number; response: PollResponse; respondedAt: Date };

// Inside the caller's transaction: records `studentId`'s answer to an open poll, or
// replaces their earlier one (responded_at becomes now). The poll row is read FOR SHARE
// first, so a close cannot slip in between the check and the write. `studentId` is the
// logged-in student (requireAuth has checked they are active).
//   404 poll_not_found  "That poll does not exist."
//   409 poll_closed     "That poll is closed."   (nothing written)
export async function answerPollInTransaction(
  c: Queryable,
  pollId: number,
  studentId: number,
  response: PollResponse,
): Promise<MyAnswer> {
  // FOR SHARE: a close (an UPDATE of this row) waits until this transaction ends, and this
  // waits for a close already under way, then sees the poll closed.
  const { rows: polls } = await c.query<{ status: PollStatus }>(
    `SELECT status FROM return_polls WHERE id = $1 FOR SHARE`,
    [pollId],
  );
  if (polls.length === 0) throw POLL_NOT_FOUND();
  if (polls[0].status !== "open") throw POLL_CLOSED();

  const { rows } = await c.query<MyAnswer>(
    `INSERT INTO return_poll_responses (poll_id, student_id, response) VALUES ($1, $2, $3)
     ON CONFLICT (poll_id, student_id)
       DO UPDATE SET response = EXCLUDED.response, responded_at = now()
     RETURNING poll_id AS "pollId", response, responded_at AS "respondedAt"`,
    [pollId, studentId, response],
  );
  return rows[0];
}

// Records an answer: the core above in one transaction.
export async function answerPoll(db: Db, pollId: number, studentId: number, response: PollResponse): Promise<MyAnswer> {
  return inTransaction(db, (c) => answerPollInTransaction(c, pollId, studentId, response));
}

// ---- Lists (Claude) ----

export type PollWithCounts = ReturnPoll & { counts: PollCounts };

// The owner's list: one page of every poll, newest first (created_at, then id), each with
// its counts (getPollCounts), and how many polls there are in all. `page` starts at 1; the
// route checks page and limit. A page past the end is empty.
export async function listPolls(
  db: Queryable,
  page: { page: number; limit: number },
): Promise<{ items: PollWithCounts[]; total: number }> {
  const { rows: counted } = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM return_polls`);
  const { rows } = await db.query<ReturnPoll>(
    `SELECT ${POLL_COLUMNS}
     FROM return_polls
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [page.limit, (page.page - 1) * page.limit],
  );
  const counts = await getPollCounts(db, rows.map((p) => p.id));
  // Every listed poll is in the Map: getPollCounts leaves out only ids that are not polls.
  return { items: rows.map((p) => ({ ...p, counts: counts.get(p.id)! })), total: counted[0].total };
}

// A student's view of an open poll: no counts and nobody else's answers, only their own
// (null and null before they answer).
export type MyOpenPoll = {
  id: number;
  title: string;
  createdAt: Date;
  myResponse: PollResponse | null;
  respondedAt: Date | null;
};

// The open polls for `studentId`, newest first: at most one while one may be open, but a
// list, so the screen does not change if that rule ever does. Closed polls are not shown.
export async function listOpenPollsForStudent(db: Queryable, studentId: number): Promise<MyOpenPoll[]> {
  const { rows } = await db.query<MyOpenPoll>(
    `SELECT p.id, p.title, p.created_at AS "createdAt",
            a.response AS "myResponse", a.responded_at AS "respondedAt"
     FROM return_polls p
     LEFT JOIN return_poll_responses a ON a.poll_id = p.id AND a.student_id = $1
     WHERE p.status = 'open'
     ORDER BY p.created_at DESC, p.id DESC`,
    [studentId],
  );
  return rows;
}

// ---- Helper ----

// Runs `fn` in one transaction on its own client: COMMIT when it returns, ROLLBACK when
// it throws (the error is passed on), and the client always goes back to the pool. The
// same helper as in services/announcements.ts.
async function inTransaction<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  try {
    await c.query("BEGIN");
    transactionStarted = true;
    const result = await fn(c);
    await c.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

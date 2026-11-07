import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  DIGEST_FEE_DAYS_AHEAD,
  DIGEST_HOUR,
  DIGEST_LINK,
  digestCounts,
  digestText,
  sendDailyDigest,
  type DigestCounts,
} from "../src/jobs/digest";
import { addDays } from "../src/lib/dates";
import { inSnapshot, insertOwner, insertStudent, testPool } from "./helpers/db";

// The owner's daily digest (day 10, Claude at Nikhil's request; section 12 lists "digest
// content" under "You write"). The counts cover every complaint, request and fee in the
// table, and other test files add those at the same time, so database tests run in one
// snapshot that is rolled back (inSnapshot) and compare counts before and after their own
// rows. Fee dates are in 1998, where no other file has fees.
const db = testPool();
afterAll(() => db.end());

const zero: DigestCounts = { complaints: 0, rejoinRequests: 0, feesDueSoon: 0, feesOverdue: 0 };

describe("digestText", () => {
  it("names every count in order", () => {
    expect(digestText({ complaints: 2, rejoinRequests: 3, feesDueSoon: 4, feesOverdue: 5 })).toEqual({
      title: "Your daily summary",
      body: "2 pending complaints, 3 rejoin requests, 4 fees due in the next 3 days, 5 overdue fees.",
    });
  });

  it("uses the singular for one", () => {
    expect(digestText({ complaints: 1, rejoinRequests: 1, feesDueSoon: 1, feesOverdue: 1 })?.body).toBe(
      "1 pending complaint, 1 rejoin request, 1 fee due in the next 3 days, 1 overdue fee.",
    );
  });

  it("leaves out the counts that are zero", () => {
    expect(digestText({ ...zero, complaints: 2 })?.body).toBe("2 pending complaints.");
    expect(digestText({ ...zero, rejoinRequests: 1, feesOverdue: 3 })?.body).toBe("1 rejoin request, 3 overdue fees.");
    expect(digestText({ ...zero, feesDueSoon: 2 })?.body).toBe("2 fees due in the next 3 days.");
  });

  it("is null when everything is zero, so nothing is sent", () => {
    expect(digestText(zero)).toBeNull();
  });
});

// ---- Rows for the counts, written straight to the tables ----

async function complaint(c: PoolClient, status: string) {
  const student = await insertStudent(c);
  await c.query(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at)
     VALUES ($1, 'plumbing', 'The tap in room 101 keeps dripping.', $2,
             CASE WHEN $2 = 'resolved' THEN now() END)`,
    [student, status],
  );
}

async function rejoinRequest(c: PoolClient, status: string, owner: number) {
  await c.query(
    `INSERT INTO rejoin_requests (student_id, status, decided_at, decided_by)
     VALUES ($1, $2, CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
             CASE WHEN $2 = 'pending' THEN NULL ELSE $3::bigint END)`,
    [await insertStudent(c, { isActive: false }), status, owner],
  );
}

async function fee(c: PoolClient, due: string, opts: { paidBy?: number; active?: boolean } = {}) {
  const student = await insertStudent(c, { isActive: opts.active ?? true });
  const paid = opts.paidBy !== undefined;
  await c.query(
    `INSERT INTO fees (student_id, due_date, amount, status, paid_on, recorded_by)
     VALUES ($1, $2, 6500, $3, $4, $5)`,
    [student, due, paid ? "paid" : "pending", paid ? due : null, opts.paidBy ?? null],
  );
}

const minus = (a: DigestCounts, b: DigestCounts): DigestCounts => ({
  complaints: a.complaints - b.complaints,
  rejoinRequests: a.rejoinRequests - b.rejoinRequests,
  feesDueSoon: a.feesDueSoon - b.feesDueSoon,
  feesOverdue: a.feesOverdue - b.feesOverdue,
});

const TODAY = "1998-04-14";

describe("digestCounts", () => {
  it("counts open and in-progress complaints, not resolved or rejected ones", () =>
    inSnapshot(db, async (c) => {
      const before = await digestCounts(c, TODAY);
      await complaint(c, "open");
      await complaint(c, "in_progress");
      await complaint(c, "resolved");
      await complaint(c, "rejected");
      expect(minus(await digestCounts(c, TODAY), before)).toEqual({ ...zero, complaints: 2 });
    }));

  it("counts pending rejoin requests, not decided ones", () =>
    inSnapshot(db, async (c) => {
      const owner = await insertOwner(c);
      const before = await digestCounts(c, TODAY);
      await rejoinRequest(c, "pending", owner);
      await rejoinRequest(c, "approved", owner);
      await rejoinRequest(c, "rejected", owner);
      expect(minus(await digestCounts(c, TODAY), before)).toEqual({ ...zero, rejoinRequests: 1 });
    }));

  it("counts pending fees due from today to 3 days ahead as due soon, and earlier ones as overdue", () =>
    inSnapshot(db, async (c) => {
      expect(DIGEST_FEE_DAYS_AHEAD).toBe(3);
      const owner = await insertOwner(c);
      const before = await digestCounts(c, TODAY);

      await fee(c, TODAY); // due soon
      await fee(c, addDays(TODAY, 3)); // due soon
      await fee(c, addDays(TODAY, 4)); // neither
      await fee(c, addDays(TODAY, -1)); // overdue
      await fee(c, addDays(TODAY, -40)); // overdue
      await fee(c, addDays(TODAY, -1), { paidBy: owner }); // paid: neither
      await fee(c, TODAY, { paidBy: owner }); // paid: neither

      expect(minus(await digestCounts(c, TODAY), before)).toEqual({ ...zero, feesDueSoon: 2, feesOverdue: 2 });
    }));

  it("counts a moved-out student's pending fee, as the dashboard does", () =>
    inSnapshot(db, async (c) => {
      const before = await digestCounts(c, TODAY);
      await fee(c, addDays(TODAY, -5), { active: false });
      expect(minus(await digestCounts(c, TODAY), before)).toEqual({ ...zero, feesOverdue: 1 });
    }));
});

// ---- The job ----

// `day` at hh:mm on India's clock (5 h 30 min ahead of UTC).
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

type Sent = { type: string; title: string; body: string | null; link: string | null; dedupKey: string | null };

const sentTo = async (c: PoolClient, user: number): Promise<Sent[]> =>
  (
    await c.query<Sent>(
      `SELECT type, title, body, link, dedup_key AS "dedupKey"
       FROM notifications WHERE user_id = $1 ORDER BY id`,
      [user],
    )
  ).rows;

// Something for the digest to report, whatever the rest of the database holds.
const somethingPending = (c: PoolClient) => complaint(c, "open");

describe("sendDailyDigest", () => {
  it("creates nothing before 8 am India time", () =>
    inSnapshot(db, async (c) => {
      expect(DIGEST_HOUR).toBe(8);
      const owner = await insertOwner(c);
      await somethingPending(c);

      expect(await sendDailyDigest(c, { now: at(TODAY, "07:59") })).toEqual({ created: 0 });
      expect(await sendDailyDigest(c, { now: at(TODAY, "00:00") })).toEqual({ created: 0 });
      expect(await sentTo(c, owner)).toEqual([]);
    }));

  it("creates the owner's digest from 8 am, with the counts, a link to the dashboard and the day's key", () =>
    inSnapshot(db, async (c) => {
      const owner = await insertOwner(c);
      await somethingPending(c);
      const expected = digestText(await digestCounts(c, TODAY))!;

      const result = await sendDailyDigest(c, { now: at(TODAY, "08:00") });

      expect(result.created).toBeGreaterThanOrEqual(1);
      expect(await sentTo(c, owner)).toEqual([
        { type: "daily_digest", ...expected, link: DIGEST_LINK, dedupKey: `digest:${TODAY}` },
      ]);
      expect(DIGEST_LINK).toBe("/");
    }));

  it("creates nothing more on later runs the same day", () =>
    inSnapshot(db, async (c) => {
      const owner = await insertOwner(c);
      await somethingPending(c);
      await sendDailyDigest(c, { now: at(TODAY, "08:07") });

      expect(await sendDailyDigest(c, { now: at(TODAY, "09:07") })).toEqual({ created: 0 });
      expect(await sendDailyDigest(c, { now: at(TODAY, "23:07") })).toEqual({ created: 0 });
      expect(await sentTo(c, owner)).toHaveLength(1);
    }));

  it("goes by India's clock, not the server's (UTC)", () =>
    inSnapshot(db, async (c) => {
      const owner = await insertOwner(c);
      await somethingPending(c);
      // 18:45 UTC on the 14th is 00:15 on the 15th in India: too early, though UTC says 18:45.
      // 03:00 UTC on the 15th is 08:30 in India.
      await sendDailyDigest(c, { now: new Date("1998-04-14T18:45:00Z") });
      expect(await sentTo(c, owner)).toEqual([]);
      await sendDailyDigest(c, { now: new Date("1998-04-15T03:00:00Z") });
      expect((await sentTo(c, owner)).map((n) => n.dedupKey)).toEqual(["digest:1998-04-15"]);
    }));

  it("creates a new digest the next day", () =>
    inSnapshot(db, async (c) => {
      const owner = await insertOwner(c);
      await somethingPending(c);
      await sendDailyDigest(c, { now: at(TODAY, "08:07") });
      await sendDailyDigest(c, { now: at("1998-04-15", "07:07") }); // too early
      await sendDailyDigest(c, { now: at("1998-04-15", "11:07") }); // a late first run

      expect((await sentTo(c, owner)).map((n) => n.dedupKey)).toEqual(["digest:1998-04-14", "digest:1998-04-15"]);
    }));

  it("sends nothing to an owner who is not active, or to any student", () =>
    inSnapshot(db, async (c) => {
      const inactiveOwner = await insertOwner(c, { isActive: false });
      const student = await insertStudent(c);
      await somethingPending(c);

      await sendDailyDigest(c, { now: at(TODAY, "08:07") });

      expect(await sentTo(c, inactiveOwner)).toEqual([]);
      expect(await sentTo(c, student)).toEqual([]);
    }));

  it("counts one notification per owner it reached", () =>
    inSnapshot(db, async (c) => {
      await somethingPending(c);
      const owners = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND is_active`)
      ).rows[0].n;
      const a = await insertOwner(c);
      const b = await insertOwner(c);

      // Digests in tests are always rolled back, so no owner has one for this day.
      expect(await sendDailyDigest(c, { now: at("1997-06-15", "08:07") })).toEqual({ created: owners + 2 });
      expect(await sentTo(c, a)).toHaveLength(1);
      expect(await sentTo(c, b)).toHaveLength(1);
    }));
});

// The digest for a day with nothing pending is covered by digestText's null case above:
// the counts cover the whole table, which other test files keep filling, so a database
// test cannot make them all zero.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { requestRejoin } from "../src/services/rejoin";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// requestRejoin in src/services/rejoin.ts (you write it). The rows are committed, so
// every test makes its own people; the whole test database is recreated on the next run.
const db = testPool();
afterAll(() => db.end());

const emailOf = async (id: number) =>
  (await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;

async function requestsOf(student: number) {
  const { rows } = await db.query(
    "SELECT status, message, decided_at FROM rejoin_requests WHERE student_id = $1 ORDER BY id",
    [student],
  );
  return rows;
}

describe("requestRejoin", () => {
  it("records a pending request for a former student, with their message", async () => {
    const student = await insertStudent(db, { isActive: false });

    expect(await requestRejoin(db, await emailOf(student), "Back from my internship in June.")).toBeUndefined();

    expect(await requestsOf(student)).toEqual([
      { status: "pending", message: "Back from my internship in June.", decided_at: null },
    ]);
  });

  it("records a request without a message", async () => {
    const student = await insertStudent(db, { isActive: false });

    await requestRejoin(db, await emailOf(student), null);

    expect(await requestsOf(student)).toEqual([{ status: "pending", message: null, decided_at: null }]);
  });

  it("matches the email in any letter case", async () => {
    const student = await insertStudent(db, { isActive: false });
    await db.query("UPDATE users SET email = $1 WHERE id = $2", [`Mixed-${randomUUID()}@Test.Local`, student]);

    await requestRejoin(db, (await emailOf(student)).toLowerCase(), null);

    expect(await requestsOf(student)).toHaveLength(1);
  });

  it("quietly does nothing for an email nobody has", async () => {
    const email = `nobody-${randomUUID()}@test.local`;

    expect(await requestRejoin(db, email, "Let me in.")).toBeUndefined();

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM rejoin_requests r JOIN users u ON u.id = r.student_id
       WHERE lower(u.email) = $1`,
      [email],
    );
    expect(rows[0].n).toBe(0);
  });

  it("quietly does nothing for a current student", async () => {
    const student = await insertStudent(db);

    expect(await requestRejoin(db, await emailOf(student), null)).toBeUndefined();

    expect(await requestsOf(student)).toEqual([]);
  });

  it("quietly does nothing for the owner, active or not", async () => {
    const owner = await insertOwner(db);
    const formerOwner = await insertOwner(db, { isActive: false });

    expect(await requestRejoin(db, await emailOf(owner), null)).toBeUndefined();
    expect(await requestRejoin(db, await emailOf(formerOwner), null)).toBeUndefined();

    expect(await requestsOf(owner)).toEqual([]);
    expect(await requestsOf(formerOwner)).toEqual([]);
  });

  it("keeps the first request when another arrives while it is pending", async () => {
    const student = await insertStudent(db, { isActive: false });
    const email = await emailOf(student);
    await requestRejoin(db, email, "First message.");

    expect(await requestRejoin(db, email, "Second message.")).toBeUndefined();

    expect(await requestsOf(student)).toEqual([{ status: "pending", message: "First message.", decided_at: null }]);
  });

  it("accepts a new request once the earlier one has been decided", async () => {
    const owner = await insertOwner(db);
    const student = await insertStudent(db, { isActive: false });
    const email = await emailOf(student);
    await requestRejoin(db, email, "First try.");
    await db.query(
      "UPDATE rejoin_requests SET status = 'rejected', decided_at = now(), decided_by = $1 WHERE student_id = $2",
      [owner, student],
    );

    await requestRejoin(db, email, "Second try.");

    expect((await requestsOf(student)).map((r) => [r.status, r.message])).toEqual([
      ["rejected", "First try."],
      ["pending", "Second try."],
    ]);
  });

  // The database refuses such a message only when it inserts a row, that is only for a
  // real former student; the guard must refuse it first, the same way for everyone.
  it.each([
    ["an empty message", ""],
    ["a message of 501 characters", "x".repeat(501)],
    ["a message of 501 emoji", "🙂".repeat(501)],
  ])("refuses %s the same way for every email, and records nothing", async (_name, message) => {
    const former = await insertStudent(db, { isActive: false });
    const emails = [await emailOf(former), `nobody-${randomUUID()}@test.local`, await emailOf(await insertStudent(db))];

    const refusals = await Promise.all(emails.map((email) => requestRejoin(db, email, message).catch((e: unknown) => e)));

    for (const err of refusals) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 400, code: "invalid_input" });
    }
    // Every email got the very same refusal.
    expect(new Set(refusals.map((e) => (e as HttpError).message)).size).toBe(1);
    expect(await requestsOf(former)).toEqual([]);
  });

  it("accepts 500 characters, counting an emoji as one, as the database does", async () => {
    const a = await insertStudent(db, { isActive: false });
    const b = await insertStudent(db, { isActive: false });

    await requestRejoin(db, await emailOf(a), "x".repeat(500));
    await requestRejoin(db, await emailOf(b), "🙂".repeat(500));

    expect(await requestsOf(a)).toHaveLength(1);
    expect(await requestsOf(b)).toHaveLength(1);
  });

  it("creates exactly one request when several arrive at once, and none of them fails", async () => {
    const student = await insertStudent(db, { isActive: false });
    const email = await emailOf(student);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => requestRejoin(db, email, `Attempt ${i + 1}`)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await requestsOf(student)).toHaveLength(1);
  });
});

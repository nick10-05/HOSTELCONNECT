import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import {
  createComplaint,
  getRaiseStatus,
  type ComplaintLimits,
  type NewComplaint,
} from "../src/services/complaints";
import { insertOwner, insertStudent, testPool } from "./helpers/db";

// createComplaint: the three limits, the 'created' event, and races; and getRaiseStatus,
// which tells the screen beforehand whether a limit is reached.
// Rows are committed, because the race tests need real concurrent transactions, so each
// test makes its own students and looks only at their rows.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const LIMITS: ComplaintLimits = { maxActive: 3, maxNewPer24h: 2 };
const TEXT = "The tap in room 101 keeps dripping all night.";

const complaint = (category: NewComplaint["category"] = "plumbing", description = TEXT): NewComplaint => ({
  category,
  description,
});

// An existing complaint, written straight to the table so a test does not depend on the
// code it checks. By default it is two days old, so it does not count towards the 24 hours.
async function addComplaint(
  student: number,
  category: NewComplaint["category"],
  opts: { status?: "open" | "in_progress" | "resolved" | "rejected"; hoursAgo?: number } = {},
): Promise<number> {
  const status = opts.status ?? "open";
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO complaints (student_id, category, description, status, resolved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $4 = 'resolved' THEN now() END,
             now() - $5::float8 * interval '1 hour', now())
     RETURNING id`,
    [student, category, TEXT, status, opts.hoursAgo ?? 48],
  );
  return rows[0].id;
}

async function complaintsOf(student: number) {
  const { rows } = await db.query<{ id: number; category: string; status: string }>(
    "SELECT id, category, status FROM complaints WHERE student_id = $1 ORDER BY id",
    [student],
  );
  return rows;
}

async function activeCount(student: number): Promise<number> {
  return (await complaintsOf(student)).filter((r) => r.status === "open" || r.status === "in_progress").length;
}

// Expects the call to be refused with this status and code, and returns the message.
async function expectRefused(call: Promise<unknown>, status: number, code: string): Promise<string> {
  const err = await call.then(
    () => {
      throw new Error("expected a refusal, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
  return (err as HttpError).message;
}

// Runs a refused call and checks that it created nothing.
async function expectRefusedNothingCreated(
  student: number,
  call: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<string> {
  const before = await complaintsOf(student);
  const message = await expectRefused(call(), status, code);
  expect(await complaintsOf(student)).toEqual(before);
  return message;
}

describe("createComplaint", () => {
  it("creates an open, normal-priority complaint with its 'created' event by the student", async () => {
    const student = await insertStudent(db);

    const { id } = await createComplaint(db, student, complaint("electrical", "The fan in room 204 does not turn on."), LIMITS);

    const { rows } = await db.query(
      `SELECT student_id, category, description, status, priority, resolved_at, photo_path
         FROM complaints WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      student_id: student,
      category: "electrical",
      description: "The fan in room 204 does not turn on.",
      status: "open",
      priority: "normal",
      resolved_at: null,
      photo_path: null,
    });

    const events = await db.query(
      "SELECT actor_id, kind, note, from_status, to_status FROM complaint_events WHERE complaint_id = $1",
      [id],
    );
    expect(events.rows).toEqual([{ actor_id: student, kind: "created", note: null, from_status: null, to_status: null }]);
  });

  it("notifies nobody", async () => {
    const student = await insertStudent(db);
    const { id } = await createComplaint(db, student, complaint(), LIMITS);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
       WHERE link = $1 OR (user_id = $2 AND type = 'complaint_update')`,
      [`/complaints/${id}`, student],
    );
    expect(rows[0].n).toBe(0);
  });

  it("lets a student use every slot: a third active complaint, a second in 24 hours", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing");
    await addComplaint(student, "food", { hoursAgo: 1 });

    await createComplaint(db, student, complaint("internet"), LIMITS);
    expect(await activeCount(student)).toBe(3);
  });

  describe("one active complaint per category", () => {
    it("refuses a second open or in-progress complaint in the same category", async () => {
      for (const status of ["open", "in_progress"] as const) {
        const student = await insertStudent(db);
        await addComplaint(student, "plumbing", { status });

        const message = await expectRefusedNothingCreated(
          student,
          () => createComplaint(db, student, complaint("plumbing"), LIMITS),
          429,
          "category_active",
        );
        expect(message, status).toBe(
          "You already have an active plumbing complaint. You can raise another one when it is resolved or rejected.",
        );
      }
    });

    it("allows another category, and the same category for another student", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing");
      await createComplaint(db, student, complaint("cleanliness"), LIMITS);
      await createComplaint(db, await insertStudent(db), complaint("plumbing"), LIMITS);
    });

    it("frees the category once the complaint is resolved or rejected", async () => {
      for (const status of ["resolved", "rejected"] as const) {
        const student = await insertStudent(db);
        await addComplaint(student, "furniture", { status });
        await createComplaint(db, student, complaint("furniture"), LIMITS);
        expect(await activeCount(student), status).toBe(1);
      }
    });
  });

  describe("active complaints", () => {
    it("refuses a fourth active complaint", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing");
      await addComplaint(student, "electrical", { status: "in_progress" });
      await addComplaint(student, "food");

      const message = await expectRefusedNothingCreated(
        student,
        () => createComplaint(db, student, complaint("internet"), LIMITS),
        429,
        "too_many_active",
      );
      expect(message).toBe(
        "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.",
      );
    });

    it("does not count resolved or rejected complaints", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing");
      await addComplaint(student, "electrical");
      for (const category of ["food", "internet", "security"] as const) {
        await addComplaint(student, category, { status: "resolved" });
      }
      await addComplaint(student, "other", { status: "rejected" });

      await createComplaint(db, student, complaint("cleanliness"), LIMITS);
      expect(await activeCount(student)).toBe(3);
    });
  });

  describe("new complaints in 24 hours", () => {
    it("refuses a third complaint within 24 hours, even when the first two are closed", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing", { status: "rejected", hoursAgo: 2 });
      await addComplaint(student, "electrical", { status: "resolved", hoursAgo: 1 });

      const message = await expectRefusedNothingCreated(
        student,
        () => createComplaint(db, student, complaint("food"), LIMITS),
        429,
        "too_many_recent",
      );
      expect(message).toBe("You can raise at most 2 complaints in 24 hours. Please try again later.");
    });

    it("is a rolling window: just under 24 hours ago counts, just over does not", async () => {
      const inside = await insertStudent(db);
      await addComplaint(inside, "plumbing", { status: "resolved", hoursAgo: 23.9 });
      await addComplaint(inside, "electrical", { status: "resolved", hoursAgo: 0.5 });
      await expectRefusedNothingCreated(
        inside,
        () => createComplaint(db, inside, complaint("food"), LIMITS),
        429,
        "too_many_recent",
      );

      const outside = await insertStudent(db);
      await addComplaint(outside, "plumbing", { status: "resolved", hoursAgo: 24.1 });
      await addComplaint(outside, "electrical", { status: "resolved", hoursAgo: 0.5 });
      await createComplaint(db, outside, complaint("food"), LIMITS);
    });
  });

  describe("the limits come from the settings", () => {
    it("uses smaller limits, in the refusal and its message", async () => {
      const a = await insertStudent(db);
      await addComplaint(a, "plumbing");
      const active = await expectRefused(
        createComplaint(db, a, complaint("food"), { maxActive: 1, maxNewPer24h: 5 }),
        429,
        "too_many_active",
      );
      expect(active).toMatch(/You already have 1 active complaint/);

      const b = await insertStudent(db);
      await addComplaint(b, "plumbing", { status: "resolved", hoursAgo: 3 });
      const recent = await expectRefused(
        createComplaint(db, b, complaint("food"), { maxActive: 10, maxNewPer24h: 1 }),
        429,
        "too_many_recent",
      );
      expect(recent).toMatch(/You can raise at most 1 complaint/);
    });

    it("allows more than the defaults with larger limits", async () => {
      const student = await insertStudent(db);
      for (const category of ["plumbing", "electrical", "food"] as const) {
        await addComplaint(student, category, { hoursAgo: 1 });
      }
      await createComplaint(db, student, complaint("internet"), { maxActive: 5, maxNewPer24h: 5 });
      expect(await activeCount(student)).toBe(4);
    });
  });

  describe("which limit is reported", () => {
    it("names the category before the number of active complaints", async () => {
      const student = await insertStudent(db);
      for (const category of ["plumbing", "electrical", "food"] as const) await addComplaint(student, category);
      await expectRefused(createComplaint(db, student, complaint("plumbing"), LIMITS), 429, "category_active");
    });

    it("names the number of active complaints before the 24 hours", async () => {
      const student = await insertStudent(db);
      await addComplaint(student, "plumbing", { hoursAgo: 1 });
      await addComplaint(student, "electrical", { hoursAgo: 2 });
      await addComplaint(student, "food");
      await expectRefused(createComplaint(db, student, complaint("internet"), LIMITS), 429, "too_many_active");
    });
  });

  describe("who may complain", () => {
    it("refuses an unknown id and an owner's id", async () => {
      const owner = await insertOwner(db);
      await expectRefused(createComplaint(db, MISSING, complaint(), LIMITS), 404, "student_not_found");
      await expectRefusedNothingCreated(
        owner,
        () => createComplaint(db, owner, complaint(), LIMITS),
        404,
        "student_not_found",
      );
    });

    it("refuses a student who has moved out", async () => {
      const student = await insertStudent(db, { isActive: false });
      await expectRefusedNothingCreated(
        student,
        () => createComplaint(db, student, complaint(), LIMITS),
        409,
        "student_inactive",
      );
    });
  });

  describe("two complaints from one student at once", () => {
    // Each race runs a few rounds with fresh students: without the lock both requests
    // usually count before either inserts, but not every time.
    const ROUNDS = 5;

    // Exactly one of the two succeeds, and the other is this clean refusal (never a raw
    // database error, which would be a 500).
    function expectOneWinner(results: PromiseSettledResult<unknown>[], code: string) {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(HttpError);
      expect(rejected[0].reason).toMatchObject({ status: 429, code });
    }

    it("cannot get past the active limit", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const student = await insertStudent(db);
        await addComplaint(student, "plumbing");
        await addComplaint(student, "electrical");

        const results = await Promise.allSettled([
          createComplaint(db, student, complaint("food"), LIMITS),
          createComplaint(db, student, complaint("internet"), LIMITS),
        ]);
        expectOneWinner(results, "too_many_active");
        expect(await activeCount(student)).toBe(3);
      }
    });

    it("cannot get past the 24-hour limit", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const student = await insertStudent(db);
        await addComplaint(student, "plumbing", { status: "resolved", hoursAgo: 1 });

        const results = await Promise.allSettled([
          createComplaint(db, student, complaint("food"), LIMITS),
          createComplaint(db, student, complaint("internet"), LIMITS),
        ]);
        expectOneWinner(results, "too_many_recent");
        expect(await complaintsOf(student)).toHaveLength(2);
      }
    });

    it("creates one complaint when both are in the same category", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const student = await insertStudent(db);

        const results = await Promise.allSettled([
          createComplaint(db, student, complaint("plumbing"), LIMITS),
          createComplaint(db, student, complaint("plumbing"), LIMITS),
        ]);
        expectOneWinner(results, "category_active");
        expect(await complaintsOf(student)).toHaveLength(1);
      }
    });
  });
});

describe("getRaiseStatus", () => {
  const ACTIVE = "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.";
  const RECENT = "You can raise at most 2 complaints in 24 hours. Please try again later.";

  it("allows a student with no complaints, and an id with none", async () => {
    const empty = { allowed: true, reason: null, activeCategories: [] };
    expect(await getRaiseStatus(db, await insertStudent(db), LIMITS)).toEqual(empty);
    expect(await getRaiseStatus(db, MISSING, LIMITS)).toEqual(empty);
  });

  it("lists the active categories in the form's order, once each, and still allows", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "security");
    await addComplaint(student, "electrical", { status: "in_progress" });
    await addComplaint(student, "plumbing", { status: "resolved" });
    await addComplaint(student, "food", { status: "rejected" });

    expect(await getRaiseStatus(db, student, LIMITS)).toEqual({
      allowed: true,
      reason: null,
      activeCategories: ["electrical", "security"],
    });
  });

  it("refuses with the active limit's message at three active complaints", async () => {
    const student = await insertStudent(db);
    for (const category of ["plumbing", "electrical", "food"] as const) await addComplaint(student, category);

    expect(await getRaiseStatus(db, student, LIMITS)).toEqual({
      allowed: false,
      reason: ACTIVE,
      activeCategories: ["plumbing", "electrical", "food"],
    });
  });

  it("refuses with the 24-hour message after two new complaints, even closed ones", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing", { status: "rejected", hoursAgo: 23.9 });
    await addComplaint(student, "electrical", { status: "resolved", hoursAgo: 1 });

    expect(await getRaiseStatus(db, student, LIMITS)).toEqual({ allowed: false, reason: RECENT, activeCategories: [] });

    const older = await insertStudent(db);
    await addComplaint(older, "plumbing", { status: "rejected", hoursAgo: 24.1 });
    await addComplaint(older, "electrical", { status: "resolved", hoursAgo: 1 });
    expect((await getRaiseStatus(db, older, LIMITS)).allowed).toBe(true);
  });

  it("gives the active limit's reason when both are reached, as createComplaint does", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing", { hoursAgo: 1 });
    await addComplaint(student, "electrical", { hoursAgo: 2 });
    await addComplaint(student, "food");

    expect((await getRaiseStatus(db, student, LIMITS)).reason).toBe(ACTIVE);
  });

  it("uses the limits it is given", async () => {
    const student = await insertStudent(db);
    await addComplaint(student, "plumbing", { hoursAgo: 1 });

    expect((await getRaiseStatus(db, student, { maxActive: 1, maxNewPer24h: 5 })).reason).toMatch(
      /You already have 1 active complaint/,
    );
    expect((await getRaiseStatus(db, student, { maxActive: 5, maxNewPer24h: 1 })).reason).toMatch(
      /You can raise at most 1 complaint/,
    );
    expect((await getRaiseStatus(db, student, { maxActive: 5, maxNewPer24h: 5 })).allowed).toBe(true);
  });

  it("agrees with createComplaint: the same refusal word for word, or a complaint created", async () => {
    const blocked = await insertStudent(db);
    for (const category of ["plumbing", "electrical", "food"] as const) await addComplaint(blocked, category);
    const status = await getRaiseStatus(db, blocked, LIMITS);
    const message = await expectRefused(createComplaint(db, blocked, complaint("internet"), LIMITS), 429, "too_many_active");
    expect(status.reason).toBe(message);

    const free = await insertStudent(db);
    await addComplaint(free, "plumbing");
    const { allowed, activeCategories } = await getRaiseStatus(db, free, LIMITS);
    expect(allowed).toBe(true);
    // An unavailable category is refused; any other is accepted.
    await expectRefused(createComplaint(db, free, complaint(activeCategories[0]), LIMITS), 429, "category_active");
    await createComplaint(db, free, complaint("internet"), LIMITS);
  });
});

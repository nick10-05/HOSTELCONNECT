import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/lib/http";
import { verifyPassword } from "../src/lib/password";
import { approveRejoinRequest, listRejoinRequests, rejectRejoinRequest } from "../src/services/rejoin";
import { reactivateStudent, type ReactivationInput } from "../src/services/students";
import { insertOwner, insertStay, insertStructure, insertStudent, testPool } from "./helpers/db";

// The owner's review of rejoin requests: listRejoinRequests and rejectRejoinRequest
// (Claude), approveRejoinRequest (you write it). Rows are committed, so each test makes
// its own people; the list tests look only at their own requests.
// Approving hashes a password at cost 12, hence the longer timeout.
const db = testPool();
afterAll(() => db.end());

const MISSING = 999_999_999;
const LEFT_ON = "2026-06-30";
const MISSING_REQUEST = MISSING;

// A former student who moved out on LEFT_ON and has asked to come back.
async function formerWithRequest(message: string | null = "Back for my final year.", createdAt?: string) {
  const owner = await insertOwner(db);
  const s = await insertStructure(db);
  const student = await insertStudent(db, { isActive: false });
  await db.query("UPDATE users SET deactivated_at = $1 WHERE id = $2", [`${LEFT_ON}T10:00:00+05:30`, student]);
  await db.query(
    `INSERT INTO stays (student_id, building_id, started_on, ended_on, created_by)
     VALUES ($1, $2, '2026-01-14', $3, $4)`,
    [student, s.building, LEFT_ON, owner],
  );
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO rejoin_requests (student_id, message, created_at) VALUES ($1, $2, coalesce($3::timestamptz, now()))
     RETURNING id`,
    [student, message, createdAt ?? null],
  );
  return { owner, s, student, request: rows[0].id };
}

const input = (overrides: Partial<ReactivationInput> & { buildingId: number }): ReactivationInput => ({
  joiningDate: "2026-11-05",
  roomId: null,
  bedId: null,
  ...overrides,
});

async function requestRow(id: number) {
  const { rows } = await db.query("SELECT status, decided_at, decided_by FROM rejoin_requests WHERE id = $1", [id]);
  return rows[0];
}

async function studentRow(id: number) {
  const { rows } = await db.query("SELECT is_active, joining_date, password_hash FROM users WHERE id = $1", [id]);
  return rows[0];
}

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const err = await call.then(
    () => {
      throw new Error("expected a refusal, but it succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

// ---- listRejoinRequests (Claude) ----

describe("listRejoinRequests", () => {
  // Every test database run is fresh, but other files add requests too, so these tests
  // look only for their own rows.
  const mine = <T extends { id: number }>(items: T[], ids: number[]) => items.filter((i) => ids.includes(i.id));

  it("lists pending requests oldest first, with the student and the day they left", async () => {
    const newer = await formerWithRequest("Newer.", "2026-11-03T09:00:00+05:30");
    const older = await formerWithRequest(null, "2026-11-01T09:00:00+05:30");

    const { items } = await listRejoinRequests(db, { status: "pending", page: 1, limit: 50 });
    const found = mine(items, [newer.request, older.request]);

    expect(found.map((i) => i.id)).toEqual([older.request, newer.request]);
    expect(found[1]).toEqual({
      id: newer.request,
      status: "pending",
      message: "Newer.",
      requestedOn: "2026-11-03",
      decidedOn: null,
      decidedByName: null,
      student: {
        id: newer.student,
        name: "Test Student",
        email: expect.stringContaining("@test.local"),
        isActive: false,
        leftOn: LEFT_ON,
      },
    });
  });

  it("lists decided requests, newest decision first, with who decided, and never mixes the two", async () => {
    const first = await formerWithRequest();
    const second = await formerWithRequest();
    const stillPending = await formerWithRequest();
    await rejectRejoinRequest(db, first.owner, first.request);
    await db.query("UPDATE rejoin_requests SET decided_at = decided_at - interval '1 day' WHERE id = $1", [
      first.request,
    ]);
    await rejectRejoinRequest(db, second.owner, second.request);

    const decided = await listRejoinRequests(db, { status: "decided", page: 1, limit: 50 });
    const pending = await listRejoinRequests(db, { status: "pending", page: 1, limit: 50 });

    const ids = [first.request, second.request, stillPending.request];
    expect(mine(decided.items, ids).map((i) => i.id)).toEqual([second.request, first.request]);
    expect(mine(decided.items, ids)[0]).toMatchObject({
      status: "rejected",
      decidedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      decidedByName: "Test Owner",
    });
    expect(mine(pending.items, ids).map((i) => i.id)).toEqual([stillPending.request]);
  });

  it("pages the list and counts every match", async () => {
    for (let i = 0; i < 3; i += 1) await formerWithRequest();

    const all = await listRejoinRequests(db, { status: "pending", page: 1, limit: 50 });
    const pageOne = await listRejoinRequests(db, { status: "pending", page: 1, limit: 2 });
    const pageTwo = await listRejoinRequests(db, { status: "pending", page: 2, limit: 2 });

    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(pageOne.total).toBe(all.total);
    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo.items.map((i) => i.id)).toEqual(all.items.slice(2, 4).map((i) => i.id));
  });
});

// ---- rejectRejoinRequest (Claude) ----

describe("rejectRejoinRequest", () => {
  it("rejects a pending request and changes nothing else", async () => {
    const { owner, student, request } = await formerWithRequest();
    const before = await studentRow(student);

    await rejectRejoinRequest(db, owner, request);

    expect(await requestRow(request)).toMatchObject({ status: "rejected", decided_by: owner });
    expect((await requestRow(request)).decided_at).toBeInstanceOf(Date);
    expect(await studentRow(student)).toEqual(before);
  });

  it("refuses an unknown request and one that is already decided", async () => {
    const { owner, request } = await formerWithRequest();
    await rejectRejoinRequest(db, owner, request);

    await expectRefused(rejectRejoinRequest(db, owner, MISSING_REQUEST), 404, "request_not_found");
    await expectRefused(rejectRejoinRequest(db, owner, request), 409, "request_decided");
  });

  it("lets only one of two simultaneous rejections through", async () => {
    const { owner, request } = await formerWithRequest();

    const results = await Promise.allSettled([
      rejectRejoinRequest(db, owner, request),
      rejectRejoinRequest(db, owner, request),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "request_decided" },
    });
  });
});

// ---- approveRejoinRequest (you write it) ----

describe("approveRejoinRequest", { timeout: 30_000 }, () => {
  it("reactivates the student and marks the request approved, together", async () => {
    const { owner, s, student, request } = await formerWithRequest();

    const result = await approveRejoinRequest(
      db,
      owner,
      request,
      input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 }),
    );

    expect(result.student).toMatchObject({
      id: student,
      joiningDate: "2026-11-05",
      buildingId: s.building,
      roomId: s.room,
      bedId: s.bed1,
    });
    const after = await studentRow(student);
    expect(after).toMatchObject({ is_active: true, joining_date: "2026-11-05" });
    expect(await verifyPassword(result.temporaryPassword, after.password_hash)).toBe(true);
    expect(await requestRow(request)).toMatchObject({ status: "approved", decided_by: owner });
    const { rows } = await db.query(
      "SELECT bed_id FROM stays WHERE student_id = $1 AND ended_on IS NULL",
      [student],
    );
    expect(rows).toEqual([{ bed_id: s.bed1 }]);
  });

  it("refuses an unknown request and one that is already decided, and changes nothing", async () => {
    const { owner, s, student, request } = await formerWithRequest();
    await rejectRejoinRequest(db, owner, request);
    const before = await studentRow(student);

    await expectRefused(approveRejoinRequest(db, owner, MISSING_REQUEST, input({ buildingId: s.building })), 404, "request_not_found");
    await expectRefused(approveRejoinRequest(db, owner, request, input({ buildingId: s.building })), 409, "request_decided");

    expect(await studentRow(student)).toEqual(before);
    expect((await requestRow(request)).status).toBe("rejected");
  });

  it("passes a reactivation refusal on, and leaves the request pending and the student moved out", async () => {
    const { owner, s, student, request } = await formerWithRequest();
    await insertStay(db, { building: s.building, room: s.room, bed: s.bed1 });
    const before = await studentRow(student);

    await expectRefused(
      approveRejoinRequest(db, owner, request, input({ buildingId: s.building, roomId: s.room, bedId: s.bed1 })),
      409,
      "bed_occupied",
    );
    await expectRefused(
      approveRejoinRequest(db, owner, request, input({ buildingId: s.building, joiningDate: "2026-06-29" })),
      409,
      "joining_before_leaving",
    );

    expect(await studentRow(student)).toEqual(before);
    expect(await requestRow(request)).toMatchObject({ status: "pending", decided_at: null, decided_by: null });
  });

  it("lets only one of two simultaneous approvals through", async () => {
    const { owner, s, student, request } = await formerWithRequest();

    const results = await Promise.allSettled([
      approveRejoinRequest(db, owner, request, input({ buildingId: s.building })),
      approveRejoinRequest(db, owner, request, input({ buildingId: s.building })),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "request_decided" },
    });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM stays WHERE student_id = $1 AND ended_on IS NULL", [
      student,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("decides a request once when an approval and a rejection race, and the student matches the decision", async () => {
    const { owner, s, student, request } = await formerWithRequest();

    const [approval, rejection] = await Promise.allSettled([
      approveRejoinRequest(db, owner, request, input({ buildingId: s.building })),
      rejectRejoinRequest(db, owner, request),
    ]);

    // Exactly one of the two decided it; the other was refused cleanly.
    expect([approval.status, rejection.status].sort()).toEqual(["fulfilled", "rejected"]);
    const loser = approval.status === "rejected" ? approval : (rejection as PromiseRejectedResult);
    expect(loser.reason).toMatchObject({ status: 409, code: "request_decided" });

    const decision = (await requestRow(request)).status;
    expect(decision).toBe(approval.status === "fulfilled" ? "approved" : "rejected");
    expect((await studentRow(student)).is_active).toBe(decision === "approved");
  });

  // Found in review: approval locked the request then the student, profile reactivation
  // the student then the request, and the two deadlocked (Postgres error 40P01, a 500).
  // Both must lock the student first. Run several times, since one race can miss.
  it("brings the student back once, with no database error, when an approval and a profile reactivation race", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { owner, s, student, request } = await formerWithRequest();

      const [approval, reactivation] = await Promise.allSettled([
        approveRejoinRequest(db, owner, request, input({ buildingId: s.building })),
        reactivateStudent(db, owner, student, input({ buildingId: s.building })),
      ]);

      // One brings the student back; the other is refused cleanly, never with a raw
      // database error such as a deadlock.
      expect([approval.status, reactivation.status].sort(), `round ${round}`).toEqual(["fulfilled", "rejected"]);
      const loser = (approval.status === "rejected" ? approval : reactivation) as PromiseRejectedResult;
      expect(loser.reason, `round ${round}`).toBeInstanceOf(HttpError);
      expect(["request_decided", "student_active"], `round ${round}`).toContain(loser.reason.code);

      expect((await studentRow(student)).is_active).toBe(true);
      expect((await requestRow(request)).status).toBe("approved");
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM stays WHERE student_id = $1 AND ended_on IS NULL",
        [student],
      );
      expect(rows[0].n).toBe(1);
    }
  });

  it("writes a message for the owner on every refusal", async () => {
    const owner = await insertOwner(db);
    const err = await approveRejoinRequest(db, owner, MISSING_REQUEST, input({ buildingId: MISSING })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message.length).toBeGreaterThan(10);
  });
});

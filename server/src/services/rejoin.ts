import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { hashPassword } from "../lib/password";
import { generateTemporaryPassword } from "../lib/tempPassword";
import type { Admission, ReactivationInput } from "./students";
import { reactivateInTransaction } from "./students";

// Rejoin requests (design doc, sections 3, 5, 8 and 9). A former student cannot log in,
// so they ask from the public "Request access" page; the owner approves or rejects.
// tests/rejoin.test.ts describes what requestRejoin must do.

// Records a request from the public form, or quietly does nothing. The same-answer rule
// (section 5): the route always gives the same reply, so this function must behave the
// same way, returning nothing and never throwing, whoever the email belongs to.
// Otherwise the form would tell anyone who lives, or lived, here.
//
// A request is created only for a moved-out student with no pending request:
//   - a former student (role 'student', is_active false)   -> a pending request
//   - an email nobody has                                   -> nothing
//   - a current student                                     -> nothing
//   - the owner (active or not)                             -> nothing
//   - a former student who already has a pending request   -> nothing; the first stays
// The email matches in any letter case. `email` arrives trimmed and lower case and
// `message` trimmed, or null when empty (routes/rejoin.ts).
//
// Never log the email or the message.
export async function requestRejoin(
  db: Queryable,
  email: string,
  message: string | null,
): Promise<void> {
  if (message !== null && ([...message].length === 0 || [...message].length > 500)) {
    throw new HttpError(400, "invalid_input", "The message must be 1 to 500 characters.");
  }

  await db.query(
    `INSERT INTO rejoin_requests (student_id, message)
     SELECT id, $2
     FROM users
     WHERE lower(email) = lower($1)
       AND role = 'student'
       AND is_active = false
     ON CONFLICT (student_id) WHERE status = 'pending'
     DO NOTHING`,
    [email, message],
  );
}

// ---- The owner's review (day 5) ----
// tests/rejoinReview.test.ts describes all three functions below.

export type RejoinStatus = "pending" | "approved" | "rejected";

// One request in the owner's list. Dates are India's dates ('YYYY-MM-DD'), like every
// other date the app shows. No phone numbers: the owner reaches those on the profile.
export type RejoinRequestItem = {
  id: number;
  status: RejoinStatus;
  message: string | null;
  requestedOn: string;
  decidedOn: string | null;
  decidedByName: string | null;
  student: {
    id: number;
    name: string;
    email: string;
    isActive: boolean;
    leftOn: string | null; // the day they moved out
  };
};

export type RejoinFilters = {
  status: "pending" | "decided"; // decided = approved or rejected
  page: number; // from 1
  limit: number;
};

// The owner's list: pending requests oldest first (the longest waiting at the top), or
// decided ones newest decision first; and how many match in all.
export async function listRejoinRequests(
  db: Queryable,
  f: RejoinFilters,
): Promise<{ items: RejoinRequestItem[]; total: number }> {
  const where = `WHERE ($1::text = 'pending') = (r.status = 'pending')`;

  const { rows: counted } = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM rejoin_requests r ${where}`,
    [f.status],
  );

  type Row = Omit<RejoinRequestItem, "student"> & {
    studentId: number;
    studentName: string;
    studentEmail: string;
    studentIsActive: boolean;
    leftOn: string | null;
  };
  const { rows } = await db.query<Row>(
    `SELECT r.id, r.status, r.message,
            to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "requestedOn",
            to_char(r.decided_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "decidedOn",
            d.name AS "decidedByName",
            u.id AS "studentId", u.name AS "studentName", u.email AS "studentEmail",
            u.is_active AS "studentIsActive",
            to_char(u.deactivated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "leftOn"
     FROM rejoin_requests r
     JOIN users u ON u.id = r.student_id
     LEFT JOIN users d ON d.id = r.decided_by
     ${where}
     ORDER BY CASE WHEN $1 = 'pending' THEN r.created_at END ASC,
              r.decided_at DESC,
              r.id
     LIMIT $2 OFFSET $3`,
    [f.status, f.limit, (f.page - 1) * f.limit],
  );

  return {
    total: counted[0].total,
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message,
      requestedOn: row.requestedOn,
      decidedOn: row.decidedOn,
      decidedByName: row.decidedByName,
      student: {
        id: row.studentId,
        name: row.studentName,
        email: row.studentEmail,
        isActive: row.studentIsActive,
        leftOn: row.leftOn,
      },
    })),
  };
}

// Why a request cannot be decided: it does not exist, or it is no longer pending.
async function refuseDecision(db: Queryable, requestId: number): Promise<never> {
  const { rows } = await db.query<{ status: RejoinStatus }>(
    "SELECT status FROM rejoin_requests WHERE id = $1",
    [requestId],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "request_not_found", "That request does not exist.");
  }
  throw new HttpError(409, "request_decided", `This request has already been ${rows[0].status}.`);
}

// Rejects a pending request (section 9: "Reject simply closes it"). Nothing else changes:
// the student stays moved out and may ask again later.
//   404 request_not_found   no request with this id
//   409 request_decided     already approved or rejected
// One conditional UPDATE, so a rejection racing an approval (which locks the request
// row) waits for it and then finds the request decided. It locks only the request and
// waits for nothing else, so it cannot deadlock.
export async function rejectRejoinRequest(
  db: Queryable,
  ownerId: number,
  requestId: number,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE rejoin_requests
     SET status = 'rejected', decided_at = now(), decided_by = $2
     WHERE id = $1 AND status = 'pending'`,
    [requestId, ownerId],
  );
  if (rowCount === 0) await refuseDecision(db, requestId);
}

// Approves a pending request (sections 5 and 9): the student is reactivated with the
// given joining date and place, a new stay and a new temporary password (shown once),
// and the request is marked approved by the owner, all in one transaction, so there is
// never a student back with the request still pending, or the other way round.
//
// The refusals (status, code):
//   404 request_not_found   no request with this id
//   409 request_decided     already approved or rejected
//   ...and every refusal of reactivation (student_active, joining_before_leaving,
//   building_not_found, room_not_found, bed_not_found, bed_retired, bed_occupied),
//   after which the request is still pending and the student still moved out.
//
// The work is reactivateInTransaction's (services/students.ts), which also marks the
// student's pending request approved, so no UPDATE of the request is needed here.
// Locks: the student, then the request (see below). Two approvals, or an approval and a
// rejection, serialize on the request; an approval and a profile reactivation on the
// student. Tests: tests/rejoinReview.test.ts.
export async function approveRejoinRequest(
  db: Db,
  ownerId: number,
  requestId: number,
  input: ReactivationInput,
): Promise<Admission> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // Lock order: the student first, then the request, as every other path does
    // (profile reactivation, move-out and transfer lock the student; the core then
    // touches the request). The other order deadlocked against a profile reactivation of
    // the same student (found in review on day 5). An unknown request locks nothing here
    // and is refused below.
    await c.query(
      `SELECT id FROM users
       WHERE id = (SELECT student_id FROM rejoin_requests WHERE id = $1)
       FOR UPDATE`,
      [requestId],
    );

    const request = await c.query<{ studentId: number; status: RejoinStatus }>(
      `SELECT student_id AS "studentId", status
       FROM rejoin_requests
       WHERE id = $1
       FOR UPDATE`,
      [requestId],
    );

    if (request.rowCount === 0) {
      throw new HttpError(404, "request_not_found", "That request does not exist.");
    }
    if (request.rows[0].status !== "pending") {
      throw new HttpError(
        409,
        "request_decided",
        `This request has already been ${request.rows[0].status}.`,
      );
    }

    const student = await reactivateInTransaction(
      c,
      ownerId,
      request.rows[0].studentId,
      input,
      passwordHash,
    );

    // The core marks every pending request for this student approved, including this
    // locked request. Previously rejected requests are not changed.
    await c.query("COMMIT");
    transactionStarted = false;

    return { student, temporaryPassword };
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

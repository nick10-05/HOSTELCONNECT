import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { hashPassword } from "../lib/password";
import { generateTemporaryPassword } from "../lib/tempPassword";
import { nextDueDate } from "./fees";

// Students: admission, the directory and the profile (design doc, sections 3, 5, 6 and 9).
// tests/students.test.ts describes what admitStudent must do; tests/studentDirectory.test.ts
// the directory and profile.

// What the route hands over: already validated and cleaned (routes/students.ts).
// Fields that do not belong to the category are null; phones are 10 digits; the email
// is trimmed and lower case; joiningDate is 'YYYY-MM-DD'.
export type AdmissionInput = {
  name: string;
  email: string;
  phone: string;
  parentPhone: string;
  category: "college" | "working" | "other";
  collegeName: string | null;
  branch: string | null;
  academicYear: number | null;
  company: string | null;
  designation: string | null;
  joiningDate: string;
  foodPreference: "veg" | "non_veg";
  // Weekdays a non-veg student eats veg, 1 = Monday ... 7 = Sunday, sorted, no repeats.
  // Always empty for a veg student (migration 006).
  vegDays: number[];
  monthlyFee: number | null;
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
};

export type AdmittedStudent = {
  id: number;
  name: string;
  email: string;
  joiningDate: string;
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
};

export type Admission = {
  student: AdmittedStudent;
  // Plain text, returned once for the owner to pass on. Never stored or logged.
  temporaryPassword: string;
};

// Admits a student: creates the account and the first stay together, or neither.
//
// The refusals the tests expect (status, code):
//   404 building_not_found  the building does not exist
//   404 room_not_found      the room does not exist or is in another building
//   404 bed_not_found       the bed does not exist or is in another room
//   409 bed_retired         the bed is retired (is_active = false)
//   409 bed_occupied        another student's current stay holds the bed
//   409 email_taken         the email (any letter case) already belongs to an account
// Each message is shown to the owner as is, so write it for him.
//
// Hints:
// - A transaction needs one connection for every statement: `const c = await db.connect()`,
//   then BEGIN ... COMMIT, ROLLBACK on any error, and c.release() in `finally`.
// - Hash before BEGIN: bcrypt takes a moment, and the transaction should stay short.
// - The stay starts on the joining date and is created_by the owner.
// - Duplicates (email, occupied bed) are not checked first: let the unique index refuse
//   the insert and turn error code 23505 into the 409. err.constraint names the index
//   (users_email_lower_key, stays_one_current_per_bed), so you can tell which one.
//   That stays right when two admissions race for the same bed.
// - No foreign key looks at beds.is_active, so the retired check is yours to write.
export async function admitStudent(
  db: Db,
  ownerId: number,
  input: AdmissionInput,
): Promise<Admission> {
  // Generate and hash before opening the transaction.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  // Use one connection for the complete transaction.
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // 1 to 3. Check the building, and the room and bed if given.
    await checkPlace(c, input);

    // 4 and 5. Create the student account and the first stay.
    const studentId = await insertStudentWithStay(c, ownerId, input, passwordHash);

    // 6. Both records are now saved successfully.
    await c.query("COMMIT");
    transactionStarted = false;

    return {
      student: {
        id: studentId,
        name: input.name,
        email: input.email,
        joiningDate: input.joiningDate,
        buildingId: input.buildingId,
        roomId: input.roomId,
        bedId: input.bedId,
      },
      temporaryPassword,
    };
  } catch (err) {
    // 7. Undo the entire transaction if anything fails.
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // Preserve the original error if rollback itself fails, but the connection may
        // be broken: release(true) below discards it instead of returning it to the pool.
        rollbackFailed = true;
      }
    }

    // Convert PostgreSQL unique constraint errors into meaningful HTTP errors.
    const pgError = err as { code?: string; constraint?: string };

    if (pgError.code === "23505") {
      if (pgError.constraint === "users_email_lower_key") {
        throw new HttpError(409, "email_taken", "This email address already belongs to an account.");
      }

      if (pgError.constraint === "stays_one_current_per_bed") {
        throw new HttpError(409, "bed_occupied", "The selected bed is already occupied.");
      }
    }

    throw err;
  } finally {
    // Always release the database connection; discard it if ROLLBACK failed.
    c.release(rollbackFailed);
  }
}

// Inserts the student's account and first stay, and returns the new student's id.
// Shared by admitStudent and scripts/import-students.ts, so both write exactly the same
// rows. It runs inside the caller's transaction (c is that transaction's connection) and
// checks nothing itself: the caller has checked the building, room and bed, and a
// duplicate email or an occupied bed arrives as Postgres error 23505.
export async function insertStudentWithStay(
  c: Queryable,
  ownerId: number,
  input: AdmissionInput,
  passwordHash: string,
): Promise<number> {
  // Create the student account. Only the password hash is stored.
  const user = await c.query<{ id: number }>(
    `INSERT INTO users (
      role, name, email, phone, parent_phone, password_hash, must_change_password,
      category, college_name, branch, academic_year, company, designation,
      joining_date, food_preference, monthly_fee, veg_days
    )
    VALUES ('student', $1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING id`,
    [
      input.name,
      input.email,
      input.phone,
      input.parentPhone,
      passwordHash,
      input.category,
      input.collegeName,
      input.branch,
      input.academicYear,
      input.company,
      input.designation,
      input.joiningDate,
      input.foodPreference,
      input.monthlyFee,
      input.vegDays,
    ],
  );
  const studentId = user.rows[0].id;

  // Create the student's first stay, starting on the joining date.
  await c.query(
    `INSERT INTO stays (student_id, building_id, room_id, bed_id, started_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [studentId, input.buildingId, input.roomId, input.bedId, input.joiningDate, ownerId],
  );

  return studentId;
}

// Checks a place before a stay is written there, inside the caller's transaction:
// admission, transfer and reactivation all apply exactly these rules (refactored out of
// admitStudent and transferStudent on day 5, unchanged).
//   404 building_not_found  the building does not exist
//   404 room_not_found      the room does not exist or is in another building
//   404 bed_not_found       the bed does not exist or is in another room
//   409 bed_retired         the bed is retired (no foreign key looks at beds.is_active)
// An occupied bed is not checked here: the unique index refuses the stay's INSERT or
// UPDATE, which stays right when two requests race for the same bed.
async function checkPlace(
  c: Queryable,
  place: { buildingId: number; roomId: number | null; bedId: number | null },
): Promise<void> {
  const building = await c.query(
    "SELECT id FROM buildings WHERE id = $1",
    [place.buildingId],
  );

  if (building.rowCount === 0) {
    throw new HttpError(404, "building_not_found", "The selected building was not found.");
  }

  // If a room was provided, verify that it belongs to this building.
  if (place.roomId !== null) {
    const room = await c.query(
      "SELECT id FROM rooms WHERE id = $1 AND building_id = $2",
      [place.roomId, place.buildingId],
    );

    if (room.rowCount === 0) {
      throw new HttpError(404, "room_not_found", "The selected room was not found in this building.");
    }
  }

  // If a bed was provided, verify its room and active status.
  if (place.bedId !== null) {
    const bed = await c.query<{ id: number; is_active: boolean }>(
      "SELECT id, is_active FROM beds WHERE id = $1 AND room_id = $2",
      [place.bedId, place.roomId],
    );

    if (bed.rowCount === 0) {
      throw new HttpError(404, "bed_not_found", "The selected bed was not found in this room.");
    }

    if (!bed.rows[0].is_active) {
      throw new HttpError(409, "bed_retired", "The selected bed is retired and cannot be assigned.");
    }
  }
}

// ---- Transfer (owner only) ----

// Where the student moves to. Already validated by the route: a bed always comes with
// its room.
export type TransferInput = {
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
};

export type TransferredStay = {
  // "transferred": the old stay ended today and a new one started today.
  // "reassigned": the stay had not started, so it was moved in place.
  kind: "transferred" | "reassigned";
  id: number; // the student's current stay: the new one, or the same one when reassigned
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
  startedOn: string; // today, or the unchanged future start when reassigned
};

// Moves a current student to another building, room or bed, all or nothing. Two paths,
// chosen by the current stay's started_on (decided on day 5):
// - started_on <= today, the student has joined: ends the current stay today and starts a
//   new one today. The old row is the history.
// - started_on > today, a future joining date: nobody has lived anywhere yet, so the
//   stay's building, room and bed are updated in place, with no history row.
//   Migration 007 allows that UPDATE only on such a stay; its trigger refuses any other
//   (23514, constraint stays_place_fixed_once_started).
// `today` is India's date ('YYYY-MM-DD'); the route passes hostelToday(), tests a fixed day.
//
// The refusals (status, code):
//   404 student_not_found   no student with this id (an owner's id counts as missing)
//   409 student_inactive    the student has moved out; reactivate instead
//   409 no_current_stay     an active student without a current stay (should not happen)
//   404 building_not_found  \
//   404 room_not_found       > same rules and messages as admitStudent
//   404 bed_not_found        |
//   409 bed_retired          |
//   409 bed_occupied        /  another student's current stay holds the bed
//   409 same_place          building, room and bed are all the same as now (decided on
//                           day 5: no history row that changes nothing)
//   409 stay_started        the trigger refused a reassignment because the stay started
//                           between computing `today` and the transaction (around
//                           midnight); a retry takes the transfer path
// All of them apply to both paths.
// A same-day transfer is allowed (decided on day 5): the old stay may start and end today,
// which is how the owner fixes a wrong bed chosen at admission.
// Locking: the student's users row is locked first, so two transfers of the same student
// run one after the other and the second starts from the stay the first created.
// Tests: tests/transfer.test.ts; the trigger itself: tests/accommodation.test.ts.
export async function transferStudent(
  db: Db,
  ownerId: number,
  studentId: number,
  to: TransferInput,
  today: string,
): Promise<TransferredStay> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // 1. Lock the student account and check that it exists and is active.
    const student = await c.query<{ isActive: boolean }>(
      `SELECT is_active AS "isActive"
       FROM users
       WHERE id = $1 AND role = 'student'
       FOR UPDATE`,
      [studentId],
    );

    if (student.rowCount === 0) {
      throw new HttpError(404, "student_not_found", "That student does not exist.");
    }

    if (!student.rows[0].isActive) {
      throw new HttpError(
        409,
        "student_inactive",
        "This student is inactive. Reactivate them before transferring.",
      );
    }

    // 2. Find and lock the student's current stay.
    const current = await c.query<{
      id: number;
      buildingId: number;
      roomId: number | null;
      bedId: number | null;
      startedOn: string;
    }>(
      `SELECT id,
              building_id AS "buildingId",
              room_id AS "roomId",
              bed_id AS "bedId",
              to_char(started_on, 'YYYY-MM-DD') AS "startedOn"
       FROM stays
       WHERE student_id = $1 AND ended_on IS NULL
       FOR UPDATE`,
      [studentId],
    );

    if (current.rowCount === 0) {
      throw new HttpError(
        409,
        "no_current_stay",
        "This student has no current stay to transfer.",
      );
    }

    const oldStay = current.rows[0];

    // 3 to 5. Check the destination building, and the room and bed if given.
    await checkPlace(c, to);

    // 6. Refuse a move to the exact same building, room and bed.
    if (
      oldStay.buildingId === to.buildingId &&
      oldStay.roomId === to.roomId &&
      oldStay.bedId === to.bedId
    ) {
      throw new HttpError(
        409,
        "same_place",
        "The student is already assigned to this place.",
      );
    }

    // 7. A future stay has not started: update its place without adding history.
    if (oldStay.startedOn > today) {
      await c.query(
        `UPDATE stays
         SET building_id = $1, room_id = $2, bed_id = $3
         WHERE id = $4`,
        [to.buildingId, to.roomId, to.bedId, oldStay.id],
      );

      await c.query("COMMIT");
      transactionStarted = false;

      return {
        kind: "reassigned",
        id: oldStay.id,
        buildingId: to.buildingId,
        roomId: to.roomId,
        bedId: to.bedId,
        startedOn: oldStay.startedOn,
      };
    }

    // 8. The stay has started: end the old stay today.
    await c.query(
      `UPDATE stays
       SET ended_on = $1
       WHERE id = $2`,
      [today, oldStay.id],
    );

    // 9. Create the new stay, starting today and attributed to the owner.
    const inserted = await c.query<{ id: number }>(
      `INSERT INTO stays (
         student_id, building_id, room_id, bed_id, started_on, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [studentId, to.buildingId, to.roomId, to.bedId, today, ownerId],
    );

    await c.query("COMMIT");
    transactionStarted = false;

    return {
      kind: "transferred",
      id: inserted.rows[0].id,
      buildingId: to.buildingId,
      roomId: to.roomId,
      bedId: to.bedId,
      startedOn: today,
    };
  } catch (err) {
    // Roll back every change if any step fails.
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // Preserve the original error if rollback itself fails, but the connection may
        // be broken: release(true) below discards it instead of returning it to the pool.
        rollbackFailed = true;
      }
    }

    // Convert the database's refusals into owner-friendly 409s.
    const pgError = err as { code?: string; constraint?: string };

    if (
      pgError.code === "23505" &&
      pgError.constraint === "stays_one_current_per_bed"
    ) {
      throw new HttpError(
        409,
        "bed_occupied",
        "The selected bed is already occupied.",
      );
    }

    if (
      pgError.code === "23514" &&
      pgError.constraint === "stays_place_fixed_once_started"
    ) {
      throw new HttpError(
        409,
        "stay_started",
        "This student's stay has just started. Please try the transfer again.",
      );
    }

    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

// ---- Moving out and coming back (owner only) ----

// Moves a student out (design doc, sections 3 and 6), all or nothing: the account is
// deactivated, so login and every request stop at once (requireAuth checks is_active),
// and the current stay ends. Complaints and fees stay; nothing is deleted.
//
// - is_active = false, deactivated_at = now().
// - The current stay ends today. A stay that has not started (a future joining date)
//   ends on its own start date instead, since ended_on may not come before started_on
//   (decided on day 5: a booking cancelled before arrival).
// - A student without a current stay is still deactivated.
// `today` is India's date ('YYYY-MM-DD'); the route passes hostelToday(), tests a fixed day.
//
// The refusals (status, code):
//   404 student_not_found   no student with this id (an owner's id counts as missing)
//   409 student_inactive    the student has already moved out
// Locking: lock the student's users row first, as transferStudent does, so a move-out and
// a transfer (or two move-outs) of the same student run one after the other.
// Tests: tests/deactivation.test.ts.
export async function deactivateStudent(db: Db, studentId: number, today: string): Promise<void> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // Lock the student first, so a transfer and a move-out cannot interleave.
    const student = await c.query<{ isActive: boolean }>(
      `SELECT is_active AS "isActive"
       FROM users
       WHERE id = $1 AND role = 'student'
       FOR UPDATE`,
      [studentId],
    );

    if (student.rowCount === 0) {
      throw new HttpError(404, "student_not_found", "That student does not exist.");
    }

    if (!student.rows[0].isActive) {
      throw new HttpError(409, "student_inactive", "This student has already moved out.");
    }

    // Deactivate the account. requireAuth and login both check is_active.
    await c.query(
      `UPDATE users
       SET is_active = false, deactivated_at = now()
       WHERE id = $1`,
      [studentId],
    );

    // End the current stay. A future stay ends on its own start date so the
    // database never receives an ended_on earlier than started_on.
    await c.query(
      `UPDATE stays
       SET ended_on = GREATEST(started_on, $1::date)
       WHERE student_id = $2 AND ended_on IS NULL`,
      [today, studentId],
    );

    await c.query("COMMIT");
    transactionStarted = false;
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

// What the owner gives when a former student comes back. Already validated by the route:
// the joining date is at most MAX_DAYS_AHEAD days ahead, and a bed comes with its room.
export type ReactivationInput = {
  joiningDate: string; // 'YYYY-MM-DD'
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
};

// Brings a former student back (design doc, sections 5, 6 and 9). Used by the owner
// directly (reactivateStudent, below) and by the approval of a rejoin request
// (approveRejoinRequest in services/rejoin.ts); both run this core in their own
// transaction.
//
// - is_active = true, deactivated_at = NULL, joining_date = the new date (the fee cycle
//   follows it), the new temporary password's hash and must_change_password = true.
// - A new stay starts on the joining date in the given place, created_by the owner.
// - Everything else on the account (name, email, phones, category, food, fee) is kept.
// - The student's pending rejoin request, if any, is marked approved by the owner, so
//   both ways back close it (decided on day 5). Decided requests are left alone.
// - Returns the student as admitStudent does; the caller adds the plain password.
//
// The refusals (status, code):
//   404 student_not_found       no student with this id (an owner's id counts as missing)
//   409 student_active          the student is already current
//   409 joining_before_leaving  the joining date is before the move-out day
//                               (India date from deactivated_at), falling back to
//                               the latest ended_on when deactivated_at is empty.
//   404 building_not_found  \
//   404 room_not_found       > checkPlace, as at admission
//   404 bed_not_found        |
//   409 bed_retired         /
//   409 bed_occupied        another student's current stay holds the bed (unique index)
// Locking: the student's users row first, as in transferStudent; the rejoin request is
// touched last. Every caller keeps that order (student, then request), or two of them
// can deadlock.
// The caller generates and hashes the temporary password before BEGIN, and owns
// COMMIT and ROLLBACK. Tests: tests/reactivation.test.ts, tests/rejoinReview.test.ts.
export async function reactivateInTransaction(
  c: Queryable,
  ownerId: number,
  studentId: number,
  input: ReactivationInput,
  passwordHash: string,
): Promise<AdmittedStudent> {
  // Lock the student first, matching transferStudent and deactivateStudent.
  const student = await c.query<{
    id: number;
    name: string;
    email: string;
    isActive: boolean;
  }>(
    `SELECT id, name, email, is_active AS "isActive"
     FROM users
     WHERE id = $1 AND role = 'student'
     FOR UPDATE`,
    [studentId],
  );

  if (student.rowCount === 0) {
    throw new HttpError(404, "student_not_found", "That student does not exist.");
  }

  const formerStudent = student.rows[0];

  if (formerStudent.isActive) {
    throw new HttpError(409, "student_active", "This student is already active.");
  }

  // Use the actual move-out day when available. MAX(ended_on) alone is
  // insufficient because a future booking cancelled before arrival ends on
  // its scheduled start date, not on the day the student moved out.
  const lastStay = await c.query<{ leftOn: string | null }>(
    `SELECT to_char(
              COALESCE(
                (u.deactivated_at AT TIME ZONE 'Asia/Kolkata')::date,
                (SELECT MAX(ended_on) FROM stays WHERE student_id = u.id)
              ),
              'YYYY-MM-DD'
            ) AS "leftOn"
     FROM users u
     WHERE u.id = $1`,
    [studentId],
  );

  const leftOn = lastStay.rows[0]?.leftOn ?? null;

  if (leftOn !== null && input.joiningDate < leftOn) {
    throw new HttpError(
      409,
      "joining_before_leaving",
      "The joining date cannot be before the student's last leaving date.",
    );
  }

  // Apply the same building, room, bed and retired-bed rules as admission.
  await checkPlace(c, input);

  // Reactivate the existing account without changing its other personal details.
  await c.query(
    `UPDATE users
     SET is_active = true,
         deactivated_at = NULL,
         joining_date = $1,
         password_hash = $2,
         must_change_password = true
     WHERE id = $3`,
    [input.joiningDate, passwordHash, studentId],
  );

  // Keep all previous stays as history and create a new stay for this return.
  try {
    await c.query(
      `INSERT INTO stays (
         student_id, building_id, room_id, bed_id, started_on, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        studentId,
        input.buildingId,
        input.roomId,
        input.bedId,
        input.joiningDate,
        ownerId,
      ],
    );
  } catch (err) {
    const pgError = err as { code?: string; constraint?: string };
    if (
      pgError.code === "23505" &&
      pgError.constraint === "stays_one_current_per_bed"
    ) {
      throw new HttpError(
        409,
        "bed_occupied",
        "The selected bed is already occupied.",
      );
    }
    throw err;
  }

  // A direct profile reactivation also closes any pending public rejoin request.
  // In an approval flow, the request row is already locked by the caller.
  await c.query(
    `UPDATE rejoin_requests
     SET status = 'approved', decided_at = now(), decided_by = $2
     WHERE student_id = $1 AND status = 'pending'`,
    [studentId, ownerId],
  );

  return {
    id: formerStudent.id,
    name: formerStudent.name,
    email: formerStudent.email,
    joiningDate: input.joiningDate,
    buildingId: input.buildingId,
    roomId: input.roomId,
    bedId: input.bedId,
  };
}

// Brings a former student back from the profile, all or nothing: a new temporary
// password (hashed before BEGIN, returned once in plain text), then the core above in
// one transaction. Same refusals as the core.
export async function reactivateStudent(
  db: Db,
  ownerId: number,
  studentId: number,
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

    const student = await reactivateInTransaction(
      c,
      ownerId,
      studentId,
      input,
      passwordHash,
    );

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

// ---- Directory and profile (owner only) ----

export type Category = AdmissionInput["category"];

// Where a student lives now. Room, floor and bed are null where the owner has not
// placed them (or not built that level).
export type Place = {
  buildingId: number;
  buildingName: string;
  floorNumber: number | null;
  roomId: number | null;
  roomNumber: string | null;
  bedId: number | null;
  bedNumber: string | null;
};

// One row of the directory. No phone numbers: the list only needs to find someone, and
// phones stay on the profile.
export type StudentListItem = {
  id: number;
  name: string;
  email: string;
  category: Category;
  joiningDate: string;
  isActive: boolean;
  place: Place | null; // null for a former student
};

export type StudentFilters = {
  search: string | null; // name, email or room number
  buildingId: number | null;
  floorId: number | null;
  roomId: number | null;
  category: Category | null;
  active: boolean | null; // null = active and former students
  page: number; // from 1
  limit: number;
};

export type Stay = Place & { id: number; startedOn: string; endedOn: string | null };

export type StudentProfile = {
  id: number;
  name: string;
  email: string;
  phone: string;
  parentPhone: string;
  category: Category;
  collegeName: string | null;
  branch: string | null;
  academicYear: number | null;
  company: string | null;
  designation: string | null;
  joiningDate: string;
  foodPreference: AdmissionInput["foodPreference"];
  vegDays: number[];
  monthlyFee: number | null;
  isActive: boolean;
  deactivatedAt: string | null; // 'YYYY-MM-DD'
  // True until the student has replaced the temporary password, i.e. never logged in.
  mustChangePassword: boolean;
  currentStay: Stay | null;
  stays: Stay[]; // every stay, newest first, the current one included
  nextDueDate: string | null; // null for a former student
};

// The joins that turn a stay's ids into names, shared by the list and the profile.
const PLACE_JOINS = `
  LEFT JOIN buildings b ON b.id = s.building_id
  LEFT JOIN rooms r ON r.id = s.room_id
  LEFT JOIN floors f ON f.id = r.floor_id
  LEFT JOIN beds bd ON bd.id = s.bed_id`;
const PLACE_COLUMNS = `
  s.building_id AS "buildingId", b.name AS "buildingName", f.number AS "floorNumber",
  s.room_id AS "roomId", r.room_number AS "roomNumber",
  s.bed_id AS "bedId", bd.bed_number AS "bedNumber"`;

type PlaceRow = { [K in keyof Place]: Place[K] | null };
const placeOf = (row: PlaceRow): Place | null =>
  row.buildingId === null
    ? null
    : {
        buildingId: row.buildingId,
        buildingName: row.buildingName!,
        floorNumber: row.floorNumber,
        roomId: row.roomId,
        roomNumber: row.roomNumber,
        bedId: row.bedId,
        bedNumber: row.bedNumber,
      };

// The search text as a LIKE pattern that matches it anywhere. % and _ are LIKE's
// wildcards and \ its escape character, so each is escaped to mean itself.
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

// The owner's directory: one page of students, sorted by name, and how many match in all.
// Every filter is a parameter ($1 ... $6); a null one is simply switched off.
export async function listStudents(
  db: Queryable,
  f: StudentFilters,
): Promise<{ items: StudentListItem[]; total: number }> {
  const from = `
    FROM users u
    LEFT JOIN stays s ON s.student_id = u.id AND s.ended_on IS NULL
    ${PLACE_JOINS}
    WHERE u.role = 'student'
      AND ($1::text IS NULL
           OR u.name ILIKE $1 OR u.email ILIKE $1 OR r.room_number ILIKE $1)
      AND ($2::bigint IS NULL OR s.building_id = $2)
      AND ($3::bigint IS NULL OR r.floor_id = $3)
      AND ($4::bigint IS NULL OR s.room_id = $4)
      AND ($5::text IS NULL OR u.category = $5)
      AND ($6::boolean IS NULL OR u.is_active = $6)`;
  const params = [
    f.search ? containsPattern(f.search) : null,
    f.buildingId,
    f.floorId,
    f.roomId,
    f.category,
    f.active,
  ];

  // Two queries, so the total is right even for a page past the end.
  const { rows: counted } = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total ${from}`,
    params,
  );
  const { rows } = await db.query<Omit<StudentListItem, "place"> & PlaceRow>(
    `SELECT u.id, u.name, u.email, u.category, u.joining_date AS "joiningDate",
            u.is_active AS "isActive", ${PLACE_COLUMNS}
     ${from}
     ORDER BY lower(u.name), u.id
     LIMIT $7 OFFSET $8`,
    [...params, f.limit, (f.page - 1) * f.limit],
  );

  return {
    total: counted[0].total,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      category: row.category,
      joiningDate: row.joiningDate,
      isActive: row.isActive,
      place: placeOf(row),
    })),
  };
}

// One student's full profile. `today` ('YYYY-MM-DD', India) decides the next due date.
export async function getStudent(db: Queryable, id: number, today: string): Promise<StudentProfile> {
  const { rows } = await db.query<Omit<StudentProfile, "currentStay" | "stays" | "nextDueDate">>(
    `SELECT id, name, email, phone, parent_phone AS "parentPhone", category,
            college_name AS "collegeName", branch, academic_year AS "academicYear",
            company, designation, joining_date AS "joiningDate",
            food_preference AS "foodPreference", veg_days AS "vegDays",
            monthly_fee AS "monthlyFee",
            is_active AS "isActive",
            -- The day the student left, as India's date, like every other date here.
            to_char(deactivated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "deactivatedAt",
            must_change_password AS "mustChangePassword"
     FROM users WHERE id = $1 AND role = 'student'`,
    [id],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "student_not_found", "That student does not exist.");
  }
  const student = rows[0];

  const { rows: stayRows } = await db.query<PlaceRow & { id: number; startedOn: string; endedOn: string | null }>(
    `SELECT s.id, s.started_on AS "startedOn", s.ended_on AS "endedOn", ${PLACE_COLUMNS}
     FROM stays s ${PLACE_JOINS}
     WHERE s.student_id = $1
     ORDER BY s.started_on DESC, s.id DESC`,
    [id],
  );
  const stays: Stay[] = stayRows.map((row) => ({
    id: row.id,
    ...placeOf(row)!,
    startedOn: row.startedOn,
    endedOn: row.endedOn,
  }));

  return {
    ...student,
    currentStay: stays.find((s) => s.endedOn === null) ?? null,
    stays,
    nextDueDate: student.isActive ? nextDueDate(student.joiningDate, today) : null,
  };
}

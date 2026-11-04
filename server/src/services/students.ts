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

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // 1. Check whether the building exists.
    const building = await c.query(
      "SELECT id FROM buildings WHERE id = $1",
      [input.buildingId],
    );

    if (building.rowCount === 0) {
      throw new HttpError(404, "building_not_found", "The selected building was not found.");
    }

    // 2. If a room was provided, verify that it belongs to this building.
    if (input.roomId !== null) {
      const room = await c.query(
        "SELECT id FROM rooms WHERE id = $1 AND building_id = $2",
        [input.roomId, input.buildingId],
      );

      if (room.rowCount === 0) {
        throw new HttpError(404, "room_not_found", "The selected room was not found in this building.");
      }
    }

    // 3. If a bed was provided, verify its room and active status.
    if (input.bedId !== null) {
      const bed = await c.query<{ id: number; is_active: boolean }>(
        "SELECT id, is_active FROM beds WHERE id = $1 AND room_id = $2",
        [input.bedId, input.roomId],
      );

      if (bed.rowCount === 0) {
        throw new HttpError(404, "bed_not_found", "The selected bed was not found in this room.");
      }

      if (!bed.rows[0].is_active) {
        throw new HttpError(409, "bed_retired", "The selected bed is retired and cannot be assigned.");
      }
    }

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
        // Preserve the original error if rollback itself fails.
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
    // Always release the database connection.
    c.release();
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

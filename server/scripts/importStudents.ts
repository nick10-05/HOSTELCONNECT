import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { markHostel, type Db } from "../src/db";
import { hashPassword } from "../src/lib/password";
import { generateTemporaryPassword } from "../src/lib/tempPassword";
import { studentDetailsSchema, type StudentDetails } from "../src/routes/students";
import { count } from "../src/services/hostels";
import { insertStudentWithStay } from "../src/services/students";

// The one-time import of the existing students (design doc, section 9): the owner's
// paper register is typed into docs/import-template.csv, and this turns it into
// accounts and stays, creating the buildings, floors, rooms and beds it names.
// Used by scripts/import-students.ts; tests/importStudents.test.ts describes it.
//
// It is all or nothing: every row is checked first, every problem is reported by row
// and column, and if there is any problem nothing is imported. Problems never repeat
// what was typed: this output may be pasted somewhere, and it holds phone numbers.

export const COLUMNS = [
  "name",
  "email",
  "phone",
  "parent_phone",
  "category",
  "college_name",
  "branch",
  "academic_year",
  "company",
  "designation",
  "joining_date",
  "food",
  "veg_days",
  "monthly_fee",
  "building",
  "floor",
  "room",
  "bed",
] as const;
// Columns a file may leave out (phase 5b): "yes" for a student under 18, and "yes" to
// confirm a parent's or guardian's consent for them. Empty or "no" means no.
export const OPTIONAL_COLUMNS = ["under_18", "guardian_consent"] as const;
type Column = (typeof COLUMNS)[number] | (typeof OPTIONAL_COLUMNS)[number];

// The CSV column behind each field of the admission rules, for messages.
const COLUMN_OF: Record<keyof StudentDetails | "guardianConsent", Column> = {
  name: "name",
  email: "email",
  phone: "phone",
  parentPhone: "parent_phone",
  category: "category",
  collegeName: "college_name",
  branch: "branch",
  academicYear: "academic_year",
  company: "company",
  designation: "designation",
  joiningDate: "joining_date",
  foodPreference: "food",
  vegDays: "veg_days",
  monthlyFee: "monthly_fee",
  under18: "under_18",
  guardianConsent: "guardian_consent",
};

// "yes" or "no" (any case), or empty for no; null for anything else.
function toYesNo(text: string): boolean | null {
  const t = text.toLowerCase();
  if (t === "yes") return true;
  if (t === "" || t === "no") return false;
  return null;
}

// row is the spreadsheet's row number (the header is row 1), or null for the whole file.
export type ImportProblem = { row: number | null; message: string };

export type Place = { building: string; floor: number | null; room: string | null; bed: string | null };
export type ImportRow = { row: number; details: StudentDetails; place: Place };

// What the owner hands out: one line per student.
export type Credential = { name: string; email: string; place: string; temporaryPassword: string };

// Thrown when the database shows a problem (an email already taken, a bed in use).
export class ImportRefused extends Error {
  constructor(readonly problems: ImportProblem[]) {
    super(`The import was refused: ${problems.length} problem(s). Nothing was imported.`);
    this.name = "ImportRefused";
  }
}

// ---- Reading the CSV ----

// '14-01-2025', '14/01/2025' or '2025-01-14' → '2025-01-14', or null if it is not a real
// day. Day-first is how Excel writes dates in India; with the 4-digit year at one end
// the formats cannot be mistaken for each other.
export function toIsoDate(text: string): string | null {
  const dayFirst = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  const yearFirst = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  let ymd: [string, string, string];
  if (dayFirst) ymd = [dayFirst[3], dayFirst[2], dayFirst[1]];
  else if (yearFirst) ymd = [yearFirst[1], yearFirst[2], yearFirst[3]];
  else return null;
  const [y, m, d] = ymd;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  // 31-02-2025 becomes 3 March in JavaScript; comparing back catches it.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// 'Tue;Sat', 'tue, sat' or 'Tuesday' → [2, 6] (1 = Monday). null if a day is unknown.
export function toVegDays(text: string): number[] | null {
  const days: number[] = [];
  for (const word of text.toLowerCase().split(/[;,\s]+/).filter(Boolean)) {
    const day = WEEKDAYS.findIndex((name) => name === word || name.slice(0, 3) === word);
    if (day === -1) return null;
    days.push(day + 1);
  }
  return days;
}

// Reads the CSV text. Returns the rows ready to import, or the problems found (then no
// rows at all, so a half-checked file can never be imported by mistake).
export function readStudentsCsv(text: string): { rows: ImportRow[]; problems: ImportProblem[] } {
  // Arrays, not objects keyed by the header: the header is checked here by hand.
  const records = parse(text, { bom: true, trim: true, skip_empty_lines: true }) as string[][];
  const header = (records[0] ?? []).map((h) => h.toLowerCase());

  const missing = COLUMNS.filter((c) => !header.includes(c));
  const known: readonly string[] = [...COLUMNS, ...OPTIONAL_COLUMNS];
  const unknown = header.filter((h) => !known.includes(h));
  const fileProblems: ImportProblem[] = [];
  if (missing.length) fileProblems.push({ row: null, message: `Missing column: ${missing.join(", ")}` });
  if (unknown.length) fileProblems.push({ row: null, message: `Unknown column: ${unknown.join(", ")}` });
  if (fileProblems.length) return { rows: [], problems: fileProblems };
  if (records.length < 2) return { rows: [], problems: [{ row: null, message: "The file has no students." }] };

  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const emailRow = new Map<string, number>();
  const bedRow = new Map<string, number>();

  records.slice(1).forEach((record, i) => {
    const row = i + 2;
    const cell = (c: Column) => record[header.indexOf(c)] ?? "";
    const problem = (message: string) => problems.push({ row, message });
    const before = problems.length;

    // Turn the text cells into the shape the admission rules expect.
    const joiningDate = toIsoDate(cell("joining_date"));
    if (!joiningDate) problem("joining_date must be a real date such as 14-01-2025");
    const vegDays = toVegDays(cell("veg_days"));
    if (!vegDays) problem("veg_days has an unknown day; use Mon, Tue, Wed, Thu, Fri, Sat or Sun");
    const under18 = toYesNo(cell("under_18"));
    if (under18 === null) problem("under_18 must be yes or no");
    const guardianConsent = toYesNo(cell("guardian_consent"));
    if (guardianConsent === null) problem("guardian_consent must be yes or no");
    const number = (c: Column) => (cell(c) === "" ? undefined : Number(cell(c).replace(/,/g, "")));
    const optional = (c: Column) => (cell(c) === "" ? undefined : cell(c));

    const result = studentDetailsSchema.safeParse({
      name: cell("name"),
      email: cell("email"),
      phone: cell("phone"),
      parentPhone: cell("parent_phone"),
      category: cell("category").toLowerCase(),
      collegeName: optional("college_name"),
      branch: optional("branch"),
      academicYear: number("academic_year"),
      company: optional("company"),
      designation: optional("designation"),
      // A placeholder when the date or days were refused above, so those are reported once.
      joiningDate: joiningDate ?? "2000-01-01",
      foodPreference: cell("food").toLowerCase(),
      vegDays: vegDays ?? [],
      monthlyFee: number("monthly_fee") ?? null,
      under18: under18 ?? false,
      guardianConsent: guardianConsent ?? false,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof typeof COLUMN_OF | undefined;
        problem(`${field ? COLUMN_OF[field] : "row"} ${issue.message}`);
      }
    }

    const floorText = cell("floor");
    const floor = floorText === "" ? null : Number(floorText);
    const place: Place = { building: cell("building"), floor, room: optional("room") ?? null, bed: optional("bed") ?? null };
    if (!place.building) problem("building is required");
    else if (place.building.length > 100) problem("building is longer than 100 characters");
    if (floor !== null && !(Number.isInteger(floor) && floor >= 0 && floor <= 99)) {
      problem("floor must be a whole number from 0 (ground) to 99");
    }
    if (place.room && place.room.length > 20) problem("room is longer than 20 characters");
    if (place.bed && place.bed.length > 10) problem("bed is longer than 10 characters");
    if (place.bed && !place.room) problem("bed needs a room");
    if (floor !== null && !place.room) problem("floor needs a room");

    // The same person or the same bed twice in one file.
    if (result.success) {
      const first = emailRow.get(result.data.email);
      if (first) problem(`email is the same as row ${first}`);
      else emailRow.set(result.data.email, row);
    }
    if (place.bed && place.room) {
      const key = [place.building, place.room, place.bed].map((s) => s.toLowerCase()).join("\u0000");
      const first = bedRow.get(key);
      if (first) problem(`bed is the same as row ${first}`);
      else bedRow.set(key, row);
    }

    if (result.success && problems.length === before) rows.push({ row, details: result.data, place });
  });

  return problems.length ? { rows: [], problems } : { rows, problems };
}

// ---- Importing ----

type ImportOptions = {
  // The hostel the students join (phase 5b); `ownerId` must be its owner.
  hostelId: number;
  // Called after each temporary password is hashed (the slow part, about 0.25 s each).
  onProgress?: (done: number, total: number) => void;
  // Called with the credentials just before COMMIT; if it fails, nothing is imported.
  // The command line writes the credentials sheet here, so there can never be accounts
  // whose passwords nobody has.
  beforeCommit?: (sheet: Credential[]) => Promise<void>;
};

const floorName = (n: number) => (n === 0 ? "Ground floor" : `Floor ${n}`);

// Imports the rows in one transaction into the hostel `hostelId`, on behalf of its owner
// `ownerId`, and returns the credentials sheet. Throws ImportRefused, with nothing
// imported, if the database shows a problem with any row, or the hostel's limits
// (phase 5a) would be passed.
export async function importStudents(
  db: Db,
  ownerId: number,
  rows: ImportRow[],
  { hostelId, onProgress, beforeCommit }: ImportOptions,
): Promise<Credential[]> {
  // Hash before BEGIN, so the transaction stays short.
  const passwords: { temporaryPassword: string; hash: string }[] = [];
  for (const _ of rows) {
    const temporaryPassword = generateTemporaryPassword();
    passwords.push({ temporaryPassword, hash: await hashPassword(temporaryPassword) });
    onProgress?.(passwords.length, rows.length);
  }

  const c = await db.connect();
  let broken = false;
  try {
    await c.query("BEGIN");
    await markHostel(c, hostelId);
    // Row-level security shows this hostel's accounts only: the owner must be among them.
    const owner = await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'owner' AND hostel_id = current_hostel_id()", [ownerId]);
    if (!owner.rowCount) throw new Error(`Account ${ownerId} is not an owner of hostel ${hostelId}.`);
    const problems: ImportProblem[] = [];

    // The hostel's limits, for the whole file at once; the hostel's row stays locked until
    // the end, as at admission. insertStudentWithStay checks each student again.
    const { rows: [limits] } = await c.query<{ studentLimit: number; buildingLimit: number; students: number; buildings: number }>(
      `SELECT student_limit AS "studentLimit", building_limit AS "buildingLimit",
              (SELECT count(*)::int FROM users WHERE hostel_id = h.id AND role = 'student' AND is_active) AS students,
              (SELECT count(*)::int FROM buildings WHERE hostel_id = h.id) AS buildings
         FROM hostels h WHERE h.id = current_hostel_id() FOR NO KEY UPDATE OF h`,
    );
    if (limits.students + rows.length > limits.studentLimit) {
      problems.push({
        row: null,
        message: `The hostel has ${count(limits.students, "current student")} and a limit of ${limits.studentLimit}: the file's ${count(rows.length, "student")} would pass it.`,
      });
    }
    const existingBuildings = new Set(
      (await c.query<{ name: string }>("SELECT lower(name) AS name FROM buildings")).rows.map((b) => b.name),
    );
    const newBuildings = new Set(rows.map((r) => r.place.building.toLowerCase()).filter((b) => !existingBuildings.has(b)));
    if (limits.buildings + newBuildings.size > limits.buildingLimit) {
      problems.push({
        row: null,
        message: `The file adds ${count(newBuildings.size, "new building")}; the hostel has ${limits.buildings} of its limit of ${count(limits.buildingLimit, "building")}.`,
      });
      throw new ImportRefused(problems);
    }
    const placed: { buildingId: number; roomId: number | null; bedId: number | null; text: string }[] = [];

    // Find or create each row's place, and look for problems the database can see.
    for (const { row, details, place } of rows) {
      const problem = (message: string) => problems.push({ row, message });

      const email = await c.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [details.email]);
      if (email.rowCount) problem("email already belongs to an account");

      const building = await findOrCreate(
        c,
        "SELECT id, name FROM buildings WHERE lower(name) = lower($1)",
        "INSERT INTO buildings (name) VALUES ($1) RETURNING id, name",
        [place.building],
      );
      const parts = [building.name];
      let roomId: number | null = null;
      let bedId: number | null = null;

      if (place.room) {
        const existing = await c.query<{ id: number; floor: number | null }>(
          `SELECT r.id, f.number AS floor FROM rooms r LEFT JOIN floors f ON f.id = r.floor_id
           WHERE r.building_id = $1 AND lower(r.room_number) = lower($2)`,
          [building.id, place.room],
        );
        let floor = existing.rows[0]?.floor ?? null;
        if (existing.rowCount) {
          roomId = existing.rows[0].id;
          if (place.floor !== null && floor !== place.floor) {
            const now = floor === null ? "has no floor" : `is on floor ${floor}`;
            problem(`room ${place.room} ${now}, not floor ${place.floor}`);
          }
        } else {
          let floorId: number | null = null;
          if (place.floor !== null) {
            floorId = (
              await findOrCreate(
                c,
                "SELECT id FROM floors WHERE building_id = $1 AND number = $2",
                "INSERT INTO floors (building_id, number) VALUES ($1, $2) RETURNING id",
                [building.id, place.floor],
              )
            ).id;
            floor = place.floor;
          }
          roomId = (
            await c.query<{ id: number }>(
              "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, $3) RETURNING id",
              [building.id, floorId, place.room],
            )
          ).rows[0].id;
        }
        if (floor !== null) parts.push(floorName(floor));
        parts.push(`Room ${place.room}`);
      }

      if (place.bed && roomId !== null) {
        const bed = await findOrCreate<{ id: number; is_active: boolean; occupied: boolean }>(
          c,
          `SELECT id, is_active,
                  EXISTS (SELECT 1 FROM stays s WHERE s.bed_id = beds.id AND s.ended_on IS NULL) AS occupied
           FROM beds WHERE room_id = $1 AND lower(bed_number) = lower($2)`,
          `INSERT INTO beds (room_id, bed_number) VALUES ($1, $2)
           RETURNING id, is_active, false AS occupied`,
          [roomId, place.bed],
        );
        if (!bed.is_active) problem("bed is retired");
        else if (bed.occupied) problem("bed already has a student");
        bedId = bed.id;
        parts.push(`Bed ${place.bed}`);
      }

      placed.push({ buildingId: building.id, roomId, bedId, text: parts.join(" · ") });
    }

    if (problems.length) throw new ImportRefused(problems);

    const sheet: Credential[] = [];
    for (const [i, { details }] of rows.entries()) {
      const { buildingId, roomId, bedId, text } = placed[i];
      await insertStudentWithStay(c, ownerId, { ...details, buildingId, roomId, bedId }, passwords[i].hash);
      sheet.push({
        name: details.name,
        email: details.email,
        place: text,
        temporaryPassword: passwords[i].temporaryPassword,
      });
    }

    await beforeCommit?.(sheet);
    await c.query("COMMIT");
    return sheet;
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      broken = true; // keep the original error; drop this connection below
    }
    throw err;
  } finally {
    c.release(broken);
  }
}

// Runs `select`; if it finds nothing, runs `insert` with the same parameters.
async function findOrCreate<T = { id: number; name: string }>(
  c: Pick<Db, "query">,
  select: string,
  insert: string,
  params: unknown[],
): Promise<T> {
  const found = await c.query(select, params);
  if (found.rowCount) return found.rows[0] as T;
  return (await c.query(insert, params)).rows[0] as T;
}

// ---- The credentials sheet ----

// Why a sheet may not be written at `file`, or null if it may. Never inside the project
// folder (it could be committed to the public repository), and always a .html file.
export function sheetPathProblem(file: string, projectRoot: string): string | null {
  const full = path.resolve(file);
  if (path.extname(full).toLowerCase() !== ".html") return "The credentials sheet must be a .html file.";
  const relative = path.relative(projectRoot.toLowerCase(), full.toLowerCase());
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return "Write the credentials sheet outside the project folder, for example in Documents.";
  }
  return null;
}

// Writes the sheet, refusing to overwrite an existing file.
export async function writeCredentialsSheet(file: string, html: string): Promise<void> {
  try {
    await writeFile(file, html, { flag: "wx" });
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") {
      throw new Error("That file already exists. Choose a new name; nothing was imported.");
    }
    throw err;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// A printable page: one row per student with the temporary password.
export function credentialsSheetHtml(sheet: Credential[], createdOn: string): string {
  const rows = sheet
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.place)}</td>` +
        `<td>${escapeHtml(s.email)}</td><td class="pw">${escapeHtml(s.temporaryPassword)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>HostelConnect temporary passwords</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  .pw { font-family: ui-monospace, monospace; font-size: 1.1em; letter-spacing: 0.1em; }
  .warn { border: 2px solid #b45309; padding: 0.75rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<h1>HostelConnect temporary passwords</h1>
<p class="warn">Created ${escapeHtml(createdOn)} for ${sheet.length} students. Give each student only their own
password, in person. Each must choose a new password at first login. When everyone has theirs,
destroy this sheet: shred the paper and delete this file.</p>
<table>
<thead><tr><th>Name</th><th>Room</th><th>Email (login)</th><th>Temporary password</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

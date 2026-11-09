import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ImportRefused,
  credentialsSheetHtml,
  importStudents,
  readStudentsCsv,
  sheetPathProblem,
  writeCredentialsSheet,
  type ImportRow,
} from "../scripts/importStudents";
import { verifyPassword } from "../src/lib/password";
import { TEMP_PASSWORD_LENGTH } from "../src/lib/tempPassword";
import { insertOwner, insertStay, testPool } from "./helpers/db";

// The CSV import in scripts/importStudents.ts. Reading a CSV needs no database; the
// import itself runs against the test database, with building names unique to each test
// because other test files use the same database at the same time.
const db = testPool();
afterAll(() => db.end());

const SAMPLE = readFileSync(path.join(__dirname, "fixtures", "students-sample.csv"), "utf8");
const HEADER =
  "name,email,phone,parent_phone,category,college_name,branch,academic_year,company,designation," +
  "joining_date,food,veg_days,monthly_fee,building,floor,room,bed";

// One CSV line for a valid "other" student; fields can be replaced by column name.
const COLUMNS = HEADER.split(",");
function line(fields: Record<string, string>): string {
  const base: Record<string, string> = {
    name: "Row Person",
    email: `row-${randomUUID()}@example.com`,
    phone: "9000010001",
    parent_phone: "9000020001",
    category: "other",
    joining_date: "14-01-2025",
    food: "veg",
    monthly_fee: "6500",
    building: "Block",
  };
  return COLUMNS.map((c) => fields[c] ?? base[c] ?? "").join(",");
}
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");

// Reads a CSV that must be valid and returns its rows.
function rowsOf(text: string): ImportRow[] {
  const { rows, problems } = readStudentsCsv(text);
  expect(problems).toEqual([]);
  return rows;
}

describe("readStudentsCsv", () => {
  it("reads the fake sample file: 10 students, no problems", () => {
    const { rows, problems } = readStudentsCsv(SAMPLE);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(10);

    // Row 2 of the spreadsheet is the first student (row 1 is the header).
    expect(rows[0]).toEqual({
      row: 2,
      details: {
        name: "Aarav Sample",
        email: "aarav.sample@example.com",
        phone: "9000010001",
        parentPhone: "9000020001",
        category: "college",
        collegeName: "Sample Engineering College",
        branch: "CSE",
        academicYear: 1,
        company: null,
        designation: null,
        joiningDate: "2025-01-14",
        foodPreference: "veg",
        vegDays: [],
        monthlyFee: 6500,
        under18: false,
      },
      place: { building: "Sample Block A", floor: 1, room: "101", bed: "A" },
    });
  });

  it("understands the date formats Excel writes and every way of naming veg days", () => {
    const rows = rowsOf(SAMPLE);
    const byName = (name: string) => rows.find((r) => r.details.name === name)!;
    expect(byName("Bhavna Sample").details).toMatchObject({ joiningDate: "2025-01-31", vegDays: [2, 6] });
    expect(byName("Chirag Sample").details).toMatchObject({ joiningDate: "2024-08-30", vegDays: [] });
    expect(byName("Esha Sample").details.vegDays).toEqual([1, 4, 6]);
    expect(byName("Harsh Sample").details.vegDays).toEqual([6]); // "sat"
    expect(byName("Jay Sample").details.vegDays).toEqual([2]); // "Tuesday"
    // A leap day in a leap year is a real date.
    expect(byName("Dsouza, Diya Sample").details.joiningDate).toBe("2024-02-29");
  });

  it("reads a quoted name with a comma, a blank fee and the ground floor", () => {
    const rows = rowsOf(SAMPLE);
    expect(rows[3].details.name).toBe("Dsouza, Diya Sample");
    expect(rows[5].details.monthlyFee).toBeNull();
    expect(rows[5].place).toEqual({ building: "Sample Block B", floor: 0, room: "G1", bed: "A" });
    expect(rows[4].place).toEqual({ building: "Sample Block A", floor: null, room: null, bed: null });
  });

  it("copes with Excel's byte-order mark and Windows line endings", () => {
    const text = "﻿" + csv(line({ name: "Excel Person" })).replace(/\n/g, "\r\n") + "\r\n";
    expect(rowsOf(text)[0].details.name).toBe("Excel Person");
  });

  it("refuses a file whose columns are missing or unknown", () => {
    expect(readStudentsCsv("name,email\nA,a@example.com").problems[0].message).toMatch(/missing column.*phone/i);
    expect(readStudentsCsv(`${HEADER},aadhaar\n`).problems[0].message).toMatch(/unknown column.*aadhaar/i);
    expect(readStudentsCsv(HEADER).problems).toEqual([{ row: null, message: "The file has no students." }]);
  });

  it("lists every problem by row and column, without repeating what was typed", () => {
    const dup = `dup-${randomUUID()}@example.com`;
    const { rows, problems } = readStudentsCsv(
      csv(
        line({ email: dup }), // row 2: fine
        line({ phone: "98765" }), // row 3
        line({ joining_date: "31-02-2025" }), // row 4: no such day
        line({ veg_days: "Tue" }), // row 5: veg student
        line({ food: "non_veg", veg_days: "Funday" }), // row 6
        line({ bed: "A" }), // row 7: bed without a room
        line({ floor: "1" }), // row 8: floor without a room
        line({ email: dup.toUpperCase() }), // row 9: same email as row 2
        line({ room: "101", bed: "A" }), // row 10
        line({ room: "101", bed: "a" }), // row 11: same bed as row 10
        line({ category: "college" }), // row 12: college fields missing
      ),
    );
    expect(rows).toEqual([]);
    const text = problems.map((p) => `Row ${p.row}: ${p.message}`);
    expect(text).toEqual([
      "Row 3: phone must be a 10-digit Indian mobile number",
      "Row 4: joining_date must be a real date such as 14-01-2025",
      "Row 5: veg_days are only for non-veg students",
      'Row 6: veg_days has an unknown day; use Mon, Tue, Wed, Thu, Fri, Sat or Sun',
      "Row 7: bed needs a room",
      "Row 8: floor needs a room",
      "Row 9: email is the same as row 2",
      "Row 11: bed is the same as row 10",
      "Row 12: college_name is required",
      "Row 12: branch is required",
      "Row 12: academic_year is required",
    ]);
    expect(text.join("\n")).not.toContain("98765");
  });
});

describe("importStudents", { timeout: 60_000 }, () => {
  const tag = () => randomUUID().slice(0, 8);

  it("imports the sample file, creating its buildings, floors, rooms and beds", async () => {
    const owner = await insertOwner(db);
    const t = tag();
    const rows = rowsOf(
      SAMPLE.replaceAll("Sample Block", `Sample ${t} Block`).replaceAll("@example.com", `.${t}@example.com`),
    );
    const progress: number[] = [];

    const sheet = await importStudents(db, owner, rows, { hostelId: 1, onProgress: (done) => progress.push(done) });

    expect(sheet).toHaveLength(10);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sheet[0]).toMatchObject({
      name: "Aarav Sample",
      email: `aarav.sample.${t}@example.com`,
      place: `Sample ${t} Block A · Floor 1 · Room 101 · Bed A`,
    });
    expect(sheet[4].place).toBe(`Sample ${t} Block A`);

    const { rows: users } = await db.query(
      `SELECT u.email, u.password_hash, u.must_change_password, u.veg_days, u.joining_date,
              s.started_on, s.created_by, b.name AS building, f.number AS floor,
              r.room_number AS room, bd.bed_number AS bed
       FROM users u
       JOIN stays s ON s.student_id = u.id AND s.ended_on IS NULL
       JOIN buildings b ON b.id = s.building_id
       LEFT JOIN rooms r ON r.id = s.room_id
       LEFT JOIN floors f ON f.id = r.floor_id
       LEFT JOIN beds bd ON bd.id = s.bed_id
       WHERE u.email LIKE $1 ORDER BY u.email`,
      [`%.${t}@example.com`],
    );
    expect(users).toHaveLength(10);
    const bhavna = users.find((u) => u.email.startsWith("bhavna"))!;
    expect(bhavna).toMatchObject({
      must_change_password: true,
      veg_days: [2, 6],
      joining_date: "2025-01-31",
      started_on: "2025-01-31",
      created_by: owner,
      building: `Sample ${t} Block A`,
      floor: 1,
      room: "101",
      bed: "B",
    });
    // Each temporary password on the sheet opens that student's account, and only it.
    const aarav = users.find((u) => u.email.startsWith("aarav"))!;
    expect(sheet[0].temporaryPassword).toHaveLength(TEMP_PASSWORD_LENGTH);
    expect(await verifyPassword(sheet[0].temporaryPassword, aarav.password_hash)).toBe(true);
    expect(await verifyPassword(sheet[1].temporaryPassword, aarav.password_hash)).toBe(false);

    // Rooms G1 and G2 of block B: G1 on the ground floor with two beds, G2 without a floor.
    const { rows: rooms } = await db.query(
      `SELECT r.room_number, f.number AS floor, count(bd.id)::int AS beds
       FROM rooms r JOIN buildings b ON b.id = r.building_id
       LEFT JOIN floors f ON f.id = r.floor_id LEFT JOIN beds bd ON bd.room_id = r.id
       WHERE b.name = $1 GROUP BY r.room_number, f.number ORDER BY r.room_number`,
      [`Sample ${t} Block B`],
    );
    expect(rooms).toEqual([
      { room_number: "105", floor: 1, beds: 1 },
      { room_number: "G1", floor: 0, beds: 2 },
      { room_number: "G2", floor: null, beds: 0 },
    ]);
  });

  it("uses a building, room and bed that already exist, whatever the letter case of the building", async () => {
    const owner = await insertOwner(db);
    const t = tag();
    const { rows: b } = await db.query("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [`Old ${t}`]);
    const { rows: r } = await db.query(
      "INSERT INTO rooms (building_id, room_number) VALUES ($1, '7') RETURNING id",
      [b[0].id],
    );
    await db.query("INSERT INTO beds (room_id, bed_number) VALUES ($1, 'A')", [r[0].id]);

    await importStudents(db, owner, rowsOf(csv(line({ building: `OLD ${t}`, room: "7", bed: "A" }))), { hostelId: 1 });

    const { rows: counts } = await db.query(
      `SELECT (SELECT count(*)::int FROM buildings WHERE lower(name) = lower($1)) AS buildings,
              (SELECT count(*)::int FROM rooms WHERE building_id = $2) AS rooms,
              (SELECT count(*)::int FROM stays WHERE room_id = $3 AND ended_on IS NULL) AS stays`,
      [`Old ${t}`, b[0].id, r[0].id],
    );
    expect(counts[0]).toEqual({ buildings: 1, rooms: 1, stays: 1 });
  });

  // Each of these refuses the whole file: nothing is imported, and every problem is named.
  async function expectRefused(rows: ImportRow[], owner: number, messages: string[]) {
    const emails = rows.map((r) => r.details.email);
    const err = await importStudents(db, owner, rows, { hostelId: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefused);
    expect((err as ImportRefused).problems.map((p) => `Row ${p.row}: ${p.message}`)).toEqual(messages);
    const { rows: found } = await db.query("SELECT 1 FROM users WHERE email = ANY($1)", [emails]);
    expect(found).toEqual([]);
  }

  it("refuses an email that already has an account, and imports nothing", async () => {
    const owner = await insertOwner(db);
    const t = tag();
    const taken = `Taken-${t}@Example.com`;
    await db.query("INSERT INTO users (role, name, email, password_hash) VALUES ('owner', 'X', $1, 'x')", [taken]);
    const rows = rowsOf(csv(line({ building: `B ${t}` }), line({ building: `B ${t}`, email: taken.toLowerCase() })));
    await expectRefused(rows, owner, ["Row 3: email already belongs to an account"]);
  });

  it("refuses a bed someone lives in, a retired bed and a room on another floor", async () => {
    const owner = await insertOwner(db);
    const t = tag();
    const name = `B ${t}`;
    const { rows: b } = await db.query("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [name]);
    const { rows: f } = await db.query(
      "INSERT INTO floors (building_id, number) VALUES ($1, 1) RETURNING id",
      [b[0].id],
    );
    const { rows: r } = await db.query(
      "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, '101') RETURNING id",
      [b[0].id, f[0].id],
    );
    const { rows: beds } = await db.query(
      "INSERT INTO beds (room_id, bed_number, is_active) VALUES ($1, 'A', true), ($1, 'B', false) RETURNING id",
      [r[0].id],
    );
    await insertStay(db, { building: b[0].id, room: r[0].id, bed: beds[0].id });

    const rows = rowsOf(
      csv(
        line({ building: name, room: "101", bed: "A" }),
        line({ building: name, room: "101", bed: "B" }),
        line({ building: name, floor: "2", room: "101" }),
        line({ building: name, floor: "1", room: "101" }), // fine
      ),
    );
    await expectRefused(rows, owner, [
      "Row 2: bed already has a student",
      "Row 3: bed is retired",
      "Row 4: room 101 is on floor 1, not floor 2",
    ]);
  });

  it("imports nothing when the step before saving fails", async () => {
    const owner = await insertOwner(db);
    const rows = rowsOf(csv(line({ building: `B ${tag()}` })));
    const err = await importStudents(db, owner, rows, {
      hostelId: 1,
      beforeCommit: async () => {
        throw new Error("could not write the sheet");
      },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "could not write the sheet" });
    const { rows: found } = await db.query("SELECT 1 FROM users WHERE email = $1", [rows[0].details.email]);
    expect(found).toEqual([]);
  });
});

describe("credentials sheet", () => {
  const repo = path.resolve(__dirname, "..", "..");

  it("may not be written inside the project", () => {
    expect(sheetPathProblem(path.join(repo, "credentials.html"), repo)).toMatch(/outside the project/);
    expect(sheetPathProblem(path.join(repo, "server", "x", "c.html"), repo)).toMatch(/outside the project/);
    expect(sheetPathProblem(path.join(tmpdir(), "credentials.html"), repo)).toBeNull();
    expect(sheetPathProblem(path.join(tmpdir(), "credentials.txt"), repo)).toMatch(/\.html/);
  });

  it("never overwrites an existing file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hc-sheet-"));
    const file = path.join(dir, "credentials.html");
    writeFileSync(file, "keep me");
    await expect(writeCredentialsSheet(file, "<p>new</p>")).rejects.toThrow(/already exists/);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  it("lists each student with their temporary password, escaping what was typed", () => {
    const html = credentialsSheetHtml(
      [{ name: "<b>Asha</b> & co", email: "a@example.com", place: "Block A", temporaryPassword: "ABCD234567" }],
      "2026-11-04",
    );
    expect(html).toContain("&lt;b&gt;Asha&lt;/b&gt; &amp; co");
    expect(html).toContain("ABCD234567");
    expect(html).toMatch(/destroy/i);
    expect(html).not.toContain("<b>Asha</b>");
  });
});

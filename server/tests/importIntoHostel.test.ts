import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ImportRefused, importStudents, readStudentsCsv, type ImportRow } from "../scripts/importStudents";
import { withHostel } from "../src/db";
import { insertOwner, insertStudent, testPool } from "./helpers/db";
import { toTestDatabaseUrl } from "./helpers/testDatabase";

// Phase 5b: the CSV import goes into one chosen hostel, on behalf of its owner, within the
// hostel's limits (phase 5a), and may mark students under 18 with their guardian's consent.
// Each test makes its own hostel with the migration credential (the app cannot set limits).
const db = testPool();
afterAll(() => db.end());

async function asAdmin<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const admin = new Client({ connectionString: toTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL!) });
  await admin.connect();
  try {
    return (await admin.query<T>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

async function hostelWith(limits: { students: number; buildings: number }) {
  const [{ id }] = await asAdmin<{ id: number }>(
    "INSERT INTO hostels (name, student_limit, building_limit) VALUES ($1, $2, $3) RETURNING id::int",
    [`Import ${randomUUID().slice(0, 8)}`, limits.students, limits.buildings],
  );
  const owner = await withHostel(db, id, (tx) => insertOwner(tx));
  return { id, owner };
}

const HEADER =
  "name,email,phone,parent_phone,category,college_name,branch,academic_year,company,designation," +
  "joining_date,food,veg_days,monthly_fee,building,floor,room,bed";

function line(fields: Record<string, string> = {}, columns = HEADER.split(",")): string {
  const base: Record<string, string> = {
    name: "Row Person",
    email: `import-${randomUUID()}@example.com`,
    phone: "9000010001",
    parent_phone: "9000020001",
    category: "other",
    joining_date: "14-01-2025",
    food: "veg",
    monthly_fee: "6500",
    building: "Main",
  };
  return columns.map((c) => fields[c] ?? base[c] ?? "").join(",");
}

function rowsOf(text: string): ImportRow[] {
  const { rows, problems } = readStudentsCsv(text);
  expect(problems).toEqual([]);
  return rows;
}

const accountsWith = async (emails: string[]) =>
  (await asAdmin<{ hostel_id: number }>("SELECT hostel_id::int FROM users WHERE email = ANY($1)", [emails])).map(
    (r) => r.hostel_id,
  );

describe("importing into a chosen hostel", { timeout: 60_000 }, () => {
  it("puts the students and their buildings in that hostel only", async () => {
    const h = await hostelWith({ students: 10, buildings: 2 });
    const rows = rowsOf([HEADER, line({ building: "Annex", room: "1" }), line({ building: "annex", room: "1" })].join("\n"));
    const sheet = await importStudents(db, h.owner, rows, { hostelId: h.id });
    expect(sheet).toHaveLength(2);

    expect(await accountsWith(rows.map((r) => r.details.email))).toEqual([h.id, h.id]);
    const buildings = await asAdmin<{ hostel_id: number; name: string }>(
      "SELECT hostel_id::int, name FROM buildings WHERE hostel_id = $1",
      [h.id],
    );
    expect(buildings).toEqual([{ hostel_id: h.id, name: "Annex" }]);
  });

  it("refuses an owner of another hostel, and imports nothing", async () => {
    const h = await hostelWith({ students: 10, buildings: 2 });
    const hostelOneOwner = await insertOwner(db);
    const rows = rowsOf([HEADER, line()].join("\n"));
    await expect(importStudents(db, hostelOneOwner, rows, { hostelId: h.id })).rejects.toThrow(
      `Account ${hostelOneOwner} is not an owner of hostel ${h.id}.`,
    );
    expect(await accountsWith(rows.map((r) => r.details.email))).toEqual([]);
  });

  it("refuses a file with more students than the hostel has room for, and imports nothing", async () => {
    const h = await hostelWith({ students: 2, buildings: 5 });
    await withHostel(db, h.id, (tx) => insertStudent(tx));
    const rows = rowsOf([HEADER, line(), line()].join("\n"));
    const err = await importStudents(db, h.owner, rows, { hostelId: h.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefused);
    expect((err as ImportRefused).problems).toEqual([
      { row: null, message: "The hostel has 1 current student and a limit of 2: the file's 2 students would pass it." },
    ]);
    expect(await accountsWith(rows.map((r) => r.details.email))).toEqual([]);
  });

  it("imports a file that fills the hostel exactly", async () => {
    const h = await hostelWith({ students: 2, buildings: 1 });
    const rows = rowsOf([HEADER, line(), line()].join("\n"));
    expect(await importStudents(db, h.owner, rows, { hostelId: h.id })).toHaveLength(2);
  });

  it("refuses a file that adds more buildings than the hostel may have, and imports nothing", async () => {
    const h = await hostelWith({ students: 10, buildings: 2 });
    await withHostel(db, h.id, (tx) => tx.query("INSERT INTO buildings (name) VALUES ('Main')"));
    // "MAIN" is the building already there; East and West are new.
    const rows = rowsOf([HEADER, line({ building: "MAIN" }), line({ building: "East" }), line({ building: "West" })].join("\n"));
    const err = await importStudents(db, h.owner, rows, { hostelId: h.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefused);
    expect((err as ImportRefused).problems).toEqual([
      { row: null, message: "The file adds 2 new buildings; the hostel has 1 of its limit of 2 buildings." },
    ]);
    expect(await accountsWith(rows.map((r) => r.details.email))).toEqual([]);
  });
});

describe("students under 18 in the CSV", { timeout: 60_000 }, () => {
  const WITH_CONSENT = `${HEADER},under_18,guardian_consent`;
  const columns = WITH_CONSENT.split(",");

  it("reads under_18 and guardian_consent as yes or no, empty meaning no, in any case", () => {
    const rows = rowsOf(
      [
        WITH_CONSENT,
        line({ under_18: "Yes", guardian_consent: "YES" }, columns),
        line({ under_18: "no" }, columns),
        line({}, columns),
      ].join("\n"),
    );
    expect(rows.map((r) => r.details.under18)).toEqual([true, false, false]);
  });

  it("refuses a student under 18 without the guardian's consent, and anything but yes or no", () => {
    const { rows, problems } = readStudentsCsv(
      [
        WITH_CONSENT,
        line({ under_18: "yes" }, columns),
        line({ under_18: "maybe", guardian_consent: "yes" }, columns),
        line({ guardian_consent: "y" }, columns),
      ].join("\n"),
    );
    expect(rows).toEqual([]);
    expect(problems.map((p) => `Row ${p.row}: ${p.message}`)).toEqual([
      "Row 2: guardian_consent must be confirmed for a student under 18",
      "Row 3: under_18 must be yes or no",
      "Row 4: guardian_consent must be yes or no",
    ]);
  });

  it("records the consent with the importing owner", async () => {
    const h = await hostelWith({ students: 10, buildings: 1 });
    const rows = rowsOf([WITH_CONSENT, line({ under_18: "yes", guardian_consent: "yes" }, columns)].join("\n"));
    await importStudents(db, h.owner, rows, { hostelId: h.id });
    const [row] = await asAdmin<{ under_18: boolean; by: number; at: Date | null }>(
      "SELECT under_18, guardian_consent_by::int AS by, guardian_consent_at AS at FROM users WHERE email = $1",
      [rows[0].details.email],
    );
    expect(row).toEqual({ under_18: true, by: h.owner, at: expect.any(Date) });
  });
});

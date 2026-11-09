import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPool, withHostel } from "../src/db";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { hostelToday } from "../src/lib/dates";
import { loadDotEnv } from "../src/loadEnv";
import { activeHostelBySlug } from "../src/services/hostels";
import {
  ImportRefused,
  credentialsSheetHtml,
  importStudents,
  readStudentsCsv,
  sheetPathProblem,
  writeCredentialsSheet,
  type ImportProblem,
} from "./importStudents";
import { isLocalDatabase } from "./resetOwnerPassword";

// Imports students from a CSV (docs/import-template.csv) into one hostel, named by its
// address, and writes the credentials sheet.
//   npm run import:students -- --hostel sns-hostel --file C:\path\students.csv --out C:\Users\you\Documents\credentials.html
// All or nothing. Local database only for now: importing into production is a separate,
// later decision (go-live). Passwords appear only in the sheet, never in this window.

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const USAGE =
  "Usage: npm run import:students -- --hostel <address> --file students.csv --out C:\\Users\\you\\Documents\\credentials.html";

function report(problems: ImportProblem[]): string {
  return problems.map((p) => (p.row === null ? p.message : `Row ${p.row}: ${p.message}`)).join("\n");
}

async function main() {
  const { hostel: slug, file, out } = parseArgs({
    options: { hostel: { type: "string" }, file: { type: "string" }, out: { type: "string" } },
  }).values;
  if (!slug || !file || !out) throw new Error(`--hostel, --file and --out are all required.\n${USAGE}`);

  // Every check that needs no database comes first, before a minute of hashing.
  const outProblem = sheetPathProblem(out, PROJECT_ROOT);
  if (outProblem) throw new Error(outProblem);
  const { rows, problems } = readStudentsCsv(readFileSync(file, "utf8"));
  if (problems.length) {
    throw new Error(`${report(problems)}\n\n${problems.length} problem(s). Nothing was imported.`);
  }

  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL ${problem}`);
  if (!isLocalDatabase(url)) {
    throw new Error(
      "DATABASE_URL points at a database on another machine. This script only imports into " +
        "the local database for now. Nothing was imported.",
    );
  }

  const db = createPool(url);
  try {
    const hostel = await activeHostelBySlug(db, slug.trim().toLowerCase());
    if (!hostel) throw new Error(`No active hostel has the address "${slug}". Nothing was imported.`);
    const owners = await withHostel(db, hostel.id, (tx) =>
      tx.query<{ id: number }>("SELECT id FROM users WHERE role = 'owner' AND hostel_id = current_hostel_id()"),
    );
    if (owners.rowCount !== 1) {
      throw new Error(`${hostel.name} must have exactly one owner account. Nothing was imported.`);
    }

    console.log(`${rows.length} students checked for ${hostel.name}. Creating temporary passwords...`);
    const sheet = await importStudents(db, owners.rows[0].id, rows, {
      hostelId: hostel.id,
      onProgress: (done, total) => {
        if (done % 20 === 0 || done === total) console.log(`  ${done} of ${total}`);
      },
      beforeCommit: (credentials) => writeCredentialsSheet(out, credentialsSheetHtml(credentials, hostelToday())),
    });
    console.log(`Imported ${sheet.length} students.`);
    console.log(`Credentials sheet: ${path.resolve(out)}`);
    console.log("Print it, hand out the passwords in person, then shred it and delete the file.");
  } catch (err) {
    if (err instanceof ImportRefused) {
      throw new Error(`${report(err.problems)}\n\n${err.message}`);
    }
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

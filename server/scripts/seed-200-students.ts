import { createPool } from "../src/db";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { hostelToday } from "../src/lib/dates";
import { hashPassword } from "../src/lib/password";
import { generateTemporaryPassword } from "../src/lib/tempPassword";
import { loadDotEnv } from "../src/loadEnv";
import { isLocalDatabase } from "./resetOwnerPassword";
import { planSeed, seedStudents } from "./seedStudents";

// Fills the LOCAL database with 200 fake students (two buildings, 10 of them former).
//   npm run seed:students
// To log in as a seeded student, set SEED_STUDENT_PASSWORD in your .env first (a
// development-only password, at least 8 characters); every seeded student gets it. Without
// it they get an unknown random password. Refuses any database that is not on this machine.

async function main() {
  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL ${problem}`);
  if (!isLocalDatabase(url)) {
    throw new Error("DATABASE_URL points at a database on another machine. Fake students only go into the local database.");
  }

  const devPassword = process.env.SEED_STUDENT_PASSWORD ?? "";
  if (devPassword && devPassword.length < 8) {
    throw new Error("SEED_STUDENT_PASSWORD must be at least 8 characters.");
  }

  const db = createPool(url);
  try {
    const owners = await db.query<{ id: number }>("SELECT id FROM users WHERE role = 'owner'");
    if (owners.rowCount !== 1) throw new Error("The database must have exactly one owner account.");

    // One hash for all 200: hashing each would take about a minute for nothing.
    const hash = await hashPassword(devPassword || generateTemporaryPassword());
    const result = await seedStudents(db, owners.rows[0].id, hash, planSeed({ today: hostelToday() }));

    console.log(`Seeded ${result.students} fake students (${result.former} former) in Seed Building A and B.`);
    console.log(
      devPassword
        ? "They log in with SEED_STUDENT_PASSWORD from your .env."
        : "They cannot log in: set SEED_STUDENT_PASSWORD in .env before seeding if you need that.",
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

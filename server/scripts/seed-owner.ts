import { parseArgs } from "node:util";
import { z } from "zod";
import { createPool, withHostel } from "../src/db";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { loadDotEnv } from "../src/loadEnv";
import { hashPassword } from "../src/lib/password";
import { generateTemporaryPassword } from "../src/lib/tempPassword";

// Creates the one owner account with a temporary password, printed once.
//   npm run seed:owner -- --name "Full Name" --email owner@example.com
// The owner must change the password at first login. Refuses if an owner exists:
// resetting the owner's password is a separate script (design doc, section 11).

const argsSchema = z.object({
  name: z.string("--name is required").trim().min(1, "--name is required"),
  email: z.email("--email must be a valid email address"),
});

async function main() {
  const parsed = argsSchema.safeParse(
    parseArgs({ options: { name: { type: "string" }, email: { type: "string" } } }).values,
  );

  if (!parsed.success) {
    throw new Error(
      `${parsed.error.issues.map((i) => i.message).join("\n")}\n` +
        'Usage: npm run seed:owner -- --name "Full Name" --email owner@example.com',
    );
  }

  const args = parsed.data;

  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL ${problem}`);

  const db = createPool(url);

  try {
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);

    // Hostel #1's owner: owners of new hostels sign up themselves (multi-tenant phase 4).
    await withHostel(db, 1, async (tx) => {
      const existing = await tx.query(
        "SELECT 1 FROM users WHERE role = 'owner' AND hostel_id = current_hostel_id() LIMIT 1",
      );
      if (existing.rowCount) {
        throw new Error("An owner account already exists. Nothing was changed.");
      }
      await tx.query(
        `INSERT INTO users (role, name, email, password_hash, must_change_password)
         VALUES ('owner', $1, $2, $3, true)`,
        [args.name, args.email, passwordHash],
      );
    });

    // The one time this password is ever shown. It is not stored anywhere in plain text.
    console.log(`Owner account created for ${args.email}.`);
    console.log(`Temporary password: ${password}`);
    console.log("It is shown only now. Log in with it and choose a new password.");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  // A duplicate email hits the unique index on lower(email).
  if ((err as { code?: string }).code === "23505") {
    console.error("That email already belongs to an account.");
  } else {
    console.error(err instanceof Error ? err.message : err);
  }

  process.exit(1);
});
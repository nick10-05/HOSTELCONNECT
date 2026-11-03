import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createPool } from "../src/db";
import { loadDotEnv } from "../src/loadEnv";
import { hashPassword } from "../src/lib/password";

// Creates the one owner account with a temporary password, printed once.
//   npm run seed:owner -- --name "Full Name" --email owner@example.com
// The owner must change the password at first login. Refuses if an owner exists:
// resetting the owner's password is a separate script (design doc, section 11).

const argsSchema = z.object({
  name: z.string("--name is required").trim().min(1, "--name is required"),
  email: z.email("--email must be a valid email address"),
});

// 12 characters of base64url, about 72 bits of randomness. Replaced on day 4 by the
// readable temporary-password generator used for admissions.
function temporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}

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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createPool(url);
  try {
    const existing = await db.query("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1");
    if (existing.rowCount) {
      throw new Error("An owner account already exists. Nothing was changed.");
    }

    const password = temporaryPassword();
    await db.query(
      `INSERT INTO users (role, name, email, password_hash, must_change_password)
       VALUES ('owner', $1, $2, $3, true)`,
      [args.name, args.email, await hashPassword(password)],
    );

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

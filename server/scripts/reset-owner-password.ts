import { parseArgs } from "node:util";
import { z } from "zod";
import { createPool } from "../src/db";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { loadDotEnv } from "../src/loadEnv";
import { isLocalDatabase, resetOwnerPassword } from "./resetOwnerPassword";

// Gives the owner a new temporary password, printed once.
//   npm run reset:owner-password -- --email owner@example.com
// The owner must change it at the next login. Local database only for now: resetting
// the production owner belongs in the recovery guide (docs/RECOVERY.md, day 10).

const argsSchema = z.object({
  email: z.email("--email must be the owner's email address"),
});

async function main() {
  const parsed = argsSchema.safeParse(parseArgs({ options: { email: { type: "string" } } }).values);
  if (!parsed.success) {
    throw new Error(
      `${parsed.error.issues.map((i) => i.message).join("\n")}\n` +
        "Usage: npm run reset:owner-password -- --email owner@example.com",
    );
  }

  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL ${problem}`);
  // Checked before connecting. The host is not printed either.
  if (!isLocalDatabase(url)) {
    throw new Error(
      "DATABASE_URL points at a database on another machine. This script only resets the " +
        "local owner. Nothing was changed.",
    );
  }

  const db = createPool(url);
  try {
    const { temporaryPassword } = await resetOwnerPassword(db, parsed.data.email);
    // The one time this password is ever shown. It is not stored anywhere in plain text.
    console.log("Owner password reset.");
    console.log(`Temporary password: ${temporaryPassword}`);
    console.log("It is shown only now. Log in with it and choose a new password.");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

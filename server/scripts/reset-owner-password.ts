import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createPool } from "../src/db";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { loadDotEnv } from "../src/loadEnv";
import { confirmationMatches, resetOwnerPassword, resetTargetProblem } from "./resetOwnerPassword";

// Gives the owner a new temporary password, printed once.
//   npm run reset:owner-password -- --email owner@example.com
//   npm run reset:owner-password -- --email owner@example.com --production
// The owner must change it at the next login. Without --production it resets the local
// owner only. With --production (day 10) it resets the owner in the database DATABASE_URL
// points at, which must be on another machine; DATABASE_URL is then read from this window
// only, never from .env, and you type the owner's email again before anything changes.
// The steps are in docs/RECOVERY.md.

const argsSchema = z.object({
  email: z.email("--email must be the owner's email address"),
  production: z.boolean().default(false),
});

const USAGE = "Usage: npm run reset:owner-password -- --email owner@example.com [--production]";

async function main() {
  const parsed = argsSchema.safeParse(
    parseArgs({ options: { email: { type: "string" }, production: { type: "boolean" } } }).values,
  );
  if (!parsed.success) {
    throw new Error(`${parsed.error.issues.map((i) => i.message).join("\n")}\n${USAGE}`);
  }
  const { email, production } = parsed.data;

  // A production run never reads .env, so production's address need not be in a file.
  if (!production) loadDotEnv();
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const problem = databaseUrlProblem(url);
  if (problem) throw new Error(`DATABASE_URL ${problem}`);
  // Checked before connecting. The host is not printed either.
  const targetProblem = resetTargetProblem({ production, url });
  if (targetProblem) throw new Error(targetProblem);

  if (production) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const typed = await rl.question(
        "This resets the PRODUCTION owner's password. Type the owner's email again to continue: ",
      );
      if (!confirmationMatches(typed, email)) {
        throw new Error("That is not the same email. Nothing was changed.");
      }
    } finally {
      rl.close();
    }
  }

  const db = createPool(url);
  try {
    const { temporaryPassword } = await resetOwnerPassword(db, email);
    // The one time this password is ever shown. It is not stored anywhere in plain text.
    console.log(production ? "Production owner password reset." : "Owner password reset.");
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

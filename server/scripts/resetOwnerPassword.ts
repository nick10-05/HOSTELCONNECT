import type { Queryable } from "../src/db";
import { hashPassword } from "../src/lib/password";
import { generateTemporaryPassword } from "../src/lib/tempPassword";

// The owner's password reset (design doc, sections 6 and 11): the owner has no one to
// ask, so the developer runs a script. It gives the owner a new one-time temporary
// password, exactly like an admission or a student reset. Used by
// scripts/reset-owner-password.ts; kept apart so tests can call it without a command line.

// Sets a new temporary password for the owner with this email (any letter case) and
// returns it. Refuses, changing nothing, if no owner has that email.
// Sessions already open stay valid but are held at the change-password screen, because
// requireAuth reads must_change_password from the database on every request.
export async function resetOwnerPassword(
  db: Queryable,
  email: string,
): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const hash = await hashPassword(temporaryPassword);
  // One statement: the role check and the change cannot be separated by another write.
  const { rowCount } = await db.query(
    `UPDATE users SET password_hash = $1, must_change_password = true
     WHERE role = 'owner' AND lower(email) = lower($2)`,
    [hash, email.trim()],
  );
  // The email is not repeated: this message may be pasted into a chat or an issue.
  if (!rowCount) throw new Error("No owner account has that email. Nothing was changed.");
  return { temporaryPassword };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// True only for a database on this machine. Without --production the script refuses
// anything else, so it can never reset the production owner by accident.
export function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Why the script must not reset the owner in the database at `url`, or null when it may
// (day 10). The message never names the host or the URL: it may be pasted into a chat.
//   local run (production false): the database must be on this machine, as before
//     "DATABASE_URL points at a database on another machine. This script only resets the
//      local owner unless you add --production. Nothing was changed."
//   production run: the database must be on another machine, so a forgotten variable
//     cannot reset the local owner while you think it is production's
//     "--production was given, but DATABASE_URL points at this machine. Set it to the
//      production database first (docs/RECOVERY.md). Nothing was changed."
// In a production run the script reads DATABASE_URL from the window only, never from .env
// (the caller does not load .env), so production's address never has to be saved in a file.
export function resetTargetProblem(opts: { production: boolean; url: string }): string | null {
  const local = isLocalDatabase(opts.url);
  if (!opts.production && !local) {
    return (
      "DATABASE_URL points at a database on another machine. This script only resets the " +
      "local owner unless you add --production. Nothing was changed."
    );
  }
  if (opts.production && local) {
    return (
      "--production was given, but DATABASE_URL points at this machine. Set it to the " +
      "production database first (docs/RECOVERY.md). Nothing was changed."
    );
  }
  return null;
}

// In a production run, the script asks you to type the owner's email again before it
// changes anything. True when what you typed is that email, ignoring letter case and spaces
// around it; an empty answer is never a match.
export function confirmationMatches(typed: string, email: string): boolean {
  const answer = typed.trim().toLowerCase();
  return answer !== "" && answer === email.trim().toLowerCase();
}

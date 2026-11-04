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

// True only for a database on this machine. The script refuses anything else, so it can
// never reset the production owner by accident.
export function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

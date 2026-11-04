import type { Queryable } from "../db";
import { HttpError } from "../lib/http";

// Rejoin requests (design doc, sections 3, 5, 8 and 9). A former student cannot log in,
// so they ask from the public "Request access" page; the owner approves or rejects.
// tests/rejoin.test.ts describes what requestRejoin must do.

// Records a request from the public form, or quietly does nothing. The same-answer rule
// (section 5): the route always gives the same reply, so this function must behave the
// same way, returning nothing and never throwing, whoever the email belongs to.
// Otherwise the form would tell anyone who lives, or lived, here.
//
// A request is created only for a moved-out student with no pending request:
//   - a former student (role 'student', is_active false)   -> a pending request
//   - an email nobody has                                   -> nothing
//   - a current student                                     -> nothing
//   - the owner (active or not)                             -> nothing
//   - a former student who already has a pending request   -> nothing; the first stays
// The email matches in any letter case. `email` arrives trimmed and lower case and
// `message` trimmed, or null when empty (routes/rejoin.ts).
//
// Never log the email or the message.
export async function requestRejoin(
  db: Queryable,
  email: string,
  message: string | null,
): Promise<void> {
  if (message !== null && ([...message].length === 0 || [...message].length > 500)) {
    throw new HttpError(400, "invalid_input", "The message must be 1 to 500 characters.");
  }

  await db.query(
    `INSERT INTO rejoin_requests (student_id, message)
     SELECT id, $2
     FROM users
     WHERE lower(email) = lower($1)
       AND role = 'student'
       AND is_active = false
     ON CONFLICT (student_id) WHERE status = 'pending'
     DO NOTHING`,
    [email, message],
  );
}

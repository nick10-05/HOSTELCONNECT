import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";

// Student complaints (design doc, sections 3, 4, 8 and 9). Day 6 is text only: photos
// come on day 8, the owner's status changes, priority and notes on day 7.
// tests/complaints.test.ts describes what createComplaint must do.

// The categories of migration 009, in the order the form shows them.
export const COMPLAINT_CATEGORIES = [
  "plumbing",
  "electrical",
  "cleanliness",
  "internet",
  "food",
  "furniture",
  "security",
  "other",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export type ComplaintStatus = "open" | "in_progress" | "resolved" | "rejected";

// From config (COMPLAINT_MAX_ACTIVE, COMPLAINT_MAX_NEW_PER_DAY); 3 and 2 by default.
export type ComplaintLimits = {
  maxActive: number; // active (open or in progress) complaints at once
  maxNewPer24h: number; // new complaints in the last 24 hours, whatever their status now
};

// `description` arrives trimmed and 10 to 500 characters long, and `category` is one of
// COMPLAINT_CATEGORIES (the route checks both with zod; the database refuses anything else).
export type NewComplaint = {
  category: ComplaintCategory;
  description: string;
};

// Creates a complaint for a student, within the three limits (sections 2, 8 and 9), or
// refuses it with nothing created. In one transaction it inserts the complaint (status
// 'open', priority 'normal') and its 'created' timeline event, whose actor is the
// student. Nobody is notified: the owner sees new complaints on his dashboard (section 9).
// Returns the new complaint's id.
//
// The refusals, checked in this order, so a student who breaks several limits is told
// the first one (status, code, message shown to the student as-is):
//   404 student_not_found    no such user, or the id is not a student's
//   409 student_inactive     the student has moved out
//   429 category_active      "You already have an active <category> complaint. You can raise
//                            another one when it is resolved or rejected."
//   429 too_many_active      "You already have <maxActive> active complaints. You can raise a
//                            new one when one of them is resolved or rejected."
//   429 too_many_recent      "You can raise at most <maxNewPer24h> complaints in 24 hours.
//                            Please try again later."
// <category> is the category as stored ("plumbing"); the numbers come from `limits`,
// never from constants. With a limit of 1, "1 active complaint" (singular) is fine but
// not required.
//
// The rules behind them:
//   - Active means status 'open' or 'in_progress'. Resolved and rejected ones free the slot.
//   - The 24-hour window is rolling (decided on day 6): complaints created in the last 24
//     hours, counted whatever their status now, so a rejected one still counts. One
//     created exactly 24 hours ago no longer counts.
//   - One active complaint per category is also the unique index
//     complaints_one_active_per_category. If the insert hits it anyway, the refusal is the
//     same 429 category_active, never a raw database error (which would be a 500).
//
// Races: the same student sending two complaints at once must not get past a limit (for
// example 4 active, or 3 in 24 hours). Lock the student's users row first (SELECT ...
// FOR UPDATE), as every other path that changes a student does, then count and insert.
// The lock also stops a move-out happening between the check and the insert.
//
// Never log the description.
export async function createComplaint(
  db: Db,
  studentId: number,
  input: NewComplaint,
  limits: ComplaintLimits,
): Promise<{ id: number }> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // The student first, as on every path that changes a student. A second complaint
    // from the same student waits here until this one commits, then counts it.
    const student = await c.query<{ role: string; isActive: boolean }>(
      `SELECT role, is_active AS "isActive" FROM users WHERE id = $1 FOR UPDATE`,
      [studentId],
    );
    if (student.rowCount === 0 || student.rows[0].role !== "student") {
      throw new HttpError(404, "student_not_found", "That student does not exist.");
    }
    if (!student.rows[0].isActive) {
      throw new HttpError(409, "student_inactive", "This student has moved out.");
    }

    // now() is this transaction's start. A complaint committed while this one waited for
    // the lock was created moments around that time, so it is inside the window.
    const { rows } = await c.query<{ active: number; recent: number; categoryActive: boolean }>(
      `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS active,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent,
              coalesce(bool_or(status IN ('open', 'in_progress') AND category = $2), false)
                AS "categoryActive"
       FROM complaints
       WHERE student_id = $1`,
      [studentId, input.category],
    );
    const counts = rows[0];
    if (counts.categoryActive) throw categoryActive(input.category);
    if (counts.active >= limits.maxActive) throw tooManyActive(limits);
    if (counts.recent >= limits.maxNewPer24h) throw tooManyRecent(limits);

    let complaintId: number;
    try {
      const inserted = await c.query<{ id: number }>(
        `INSERT INTO complaints (student_id, category, description)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [studentId, input.category, input.description],
      );
      complaintId = inserted.rows[0].id;
    } catch (err) {
      // The index is the guard if a path ever skips the lock or the check above.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "complaints_one_active_per_category") {
        throw categoryActive(input.category);
      }
      throw err;
    }

    await c.query(
      `INSERT INTO complaint_events (complaint_id, actor_id, kind) VALUES ($1, $2, 'created')`,
      [complaintId, studentId],
    );

    await c.query("COMMIT");
    transactionStarted = false;

    return { id: complaintId };
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

function categoryActive(category: ComplaintCategory): HttpError {
  return new HttpError(
    429,
    "category_active",
    `You already have an active ${category} complaint. You can raise another one when it is resolved or rejected.`,
  );
}

// The two count limits' refusals; getRaiseStatus shows the same messages as reasons.
function tooManyActive(limits: ComplaintLimits): HttpError {
  return new HttpError(
    429,
    "too_many_active",
    `You already have ${limits.maxActive} active complaints. You can raise a new one when one of them is resolved or rejected.`,
  );
}

function tooManyRecent(limits: ComplaintLimits): HttpError {
  return new HttpError(
    429,
    "too_many_recent",
    `You can raise at most ${limits.maxNewPer24h} complaints in 24 hours. Please try again later.`,
  );
}

// ---- Can the student raise a complaint now? (day 6) ----
// tests/complaints.test.ts describes it.

// What the "New complaint" button and the form need (section 9: the button is "disabled
// with the reason shown when a limit is reached").
//   allowed            false when the active or the 24-hour limit is reached
//   reason             that refusal's message, word for word as createComplaint would
//                      send it (the active limit first, as there); null when allowed
//   activeCategories   categories with an active complaint, in COMPLAINT_CATEGORIES order;
//                      the form shows them as unavailable. They cannot block the button,
//                      because the category is chosen on the form.
// A hint for the screen only: createComplaint checks everything again under its lock, so
// a stale answer can never let a complaint through. Read outside a transaction.
export type RaiseStatus = {
  allowed: boolean;
  reason: string | null;
  activeCategories: ComplaintCategory[];
};

export async function getRaiseStatus(
  db: Queryable,
  studentId: number,
  limits: ComplaintLimits,
): Promise<RaiseStatus> {
  const { rows } = await db.query<{ active: number; recent: number; activeCategories: string[] }>(
    `SELECT count(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS active,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent,
            coalesce(array_agg(DISTINCT category) FILTER (WHERE status IN ('open', 'in_progress')), '{}')
              AS "activeCategories"
     FROM complaints
     WHERE student_id = $1`,
    [studentId],
  );
  const { active, recent } = rows[0];
  const activeSet = new Set(rows[0].activeCategories);
  const activeCategories = COMPLAINT_CATEGORIES.filter((category) => activeSet.has(category));

  const refusal =
    active >= limits.maxActive ? tooManyActive(limits) : recent >= limits.maxNewPer24h ? tooManyRecent(limits) : null;

  return { allowed: refusal === null, reason: refusal?.message ?? null, activeCategories };
}

// ---- A student's own complaints (day 6) ----
// tests/myComplaints.test.ts describes both functions below.
//
// The ownership filter (sections 6 and 8): a student reads only their own complaints,
// and the rule lives inside the SQL (WHERE ... AND student_id = $n), never as a check
// after loading the row. The student never sees the priority (section 4), the photo
// fields (day 8) or who wrote a timeline entry. Times are timestamps (Date), like the
// bell's; the screen shows them in India's time.

export type ComplaintEventKind = "created" | "status_change" | "note";

// One timeline entry, as the student sees it.
export type ComplaintEventItem = {
  kind: ComplaintEventKind;
  note: string | null;
  fromStatus: ComplaintStatus | null;
  toStatus: ComplaintStatus | null;
  createdAt: Date;
};

// One complaint in the student's list. Exactly these fields: no priority, no photo
// fields, no student id.
export type MyComplaintItem = {
  id: number;
  category: ComplaintCategory;
  description: string;
  status: ComplaintStatus;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

// The detail page: the complaint and its whole timeline, oldest entry first.
export type MyComplaintDetail = MyComplaintItem & { events: ComplaintEventItem[] };

// The student's own complaints, newest first (ties by id, newest first), one page at a
// time; and how many they have in all. `page` starts at 1; the route checks page and
// limit (default 20, at most 50). A page past the end is empty, with the same total.
// Any other id (another student, an owner, nobody) simply has no complaints.
export async function listMyComplaints(
  db: Queryable,
  studentId: number,
  page: { page: number; limit: number },
): Promise<{ items: MyComplaintItem[]; total: number }> {
  const { rows: counted } = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM complaints WHERE student_id = $1`,
    [studentId],
  );

  const { rows } = await db.query<MyComplaintItem>(
    `SELECT ${MY_COMPLAINT_COLUMNS}
     FROM complaints
     WHERE student_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [studentId, page.limit, (page.page - 1) * page.limit],
  );

  return { items: rows, total: counted[0].total };
}

// One of the student's own complaints with its timeline (entries by created_at, ties by
// id, oldest first).
//   404 complaint_not_found   "That complaint does not exist."
// The same refusal, with the same message, for an id that does not exist and for
// another student's complaint, so ids cannot be probed (sections 6 and 8: 404, not 403).
export async function getMyComplaint(
  db: Queryable,
  studentId: number,
  complaintId: number,
): Promise<MyComplaintDetail> {
  // The ownership filter is part of the lookup, so another student's complaint is simply
  // not found, exactly like an id that does not exist.
  const { rows } = await db.query<MyComplaintItem>(
    `SELECT ${MY_COMPLAINT_COLUMNS}
     FROM complaints
     WHERE id = $1 AND student_id = $2`,
    [complaintId, studentId],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
  }

  // Only reached for the student's own complaint. actor_id is left out on purpose.
  const { rows: events } = await db.query<ComplaintEventItem>(
    `SELECT kind, note,
            from_status AS "fromStatus",
            to_status AS "toStatus",
            created_at AS "createdAt"
     FROM complaint_events
     WHERE complaint_id = $1
     ORDER BY created_at, id`,
    [complaintId],
  );

  return { ...rows[0], events };
}

// Exactly MyComplaintItem's fields, named one by one: SELECT * would also return the
// priority, the photo fields and the student id.
const MY_COMPLAINT_COLUMNS = `id, category, description, status,
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            resolved_at AS "resolvedAt"`;

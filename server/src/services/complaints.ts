import type { Db, Queryable } from "../db";
import { HttpError } from "../lib/http";
import { newPhotoPath, StorageError, type PhotoStorage, type PhotoType } from "../lib/storage";
import { notify } from "./notifications";
import { getUsage, type UsageLimits } from "./usage";

// Student complaints (design doc, sections 3, 4, 8 and 9). Day 6 was text only; the
// owner's status changes, priority and notes came on day 7, the optional photo on day 8.
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
// `photo` (day 8) arrives already checked by the route: at most PHOTO_MAX_BYTES, and its
// type read from its first bytes (detectPhotoType), never from what the browser claims.
export type NewComplaint = {
  category: ComplaintCategory;
  description: string;
  photo?: { bytes: Uint8Array; type: PhotoType } | null;
};

// What a photo needs (day 8): the storage (null when it is not configured: uploads are
// off), the usage guard's limits, and the time the guard reads its month from.
export type PhotoUploads = {
  storage: PhotoStorage | null;
  usageLimits: UsageLimits;
  now: Date;
};

// How long a photo is kept (section 4); the expiry job deletes it after that.
export const PHOTO_KEEP_HOURS = 48;

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
// The photo (day 8, written by Claude): only after the student lock and the three limits,
// so a refused complaint never uploads anything. Then, still in the same transaction:
//   - uploads off (no storage, or the usage guard at UPLOADS_OFF_PERCENT): the whole
//     request is refused, never silently saved without its photo (decided on day 8);
//   - upload under a new random name (newPhotoPath); storage failing is a 503;
//   - insert with photo_path, photo_size_bytes and photo_expires_at = created_at +
//     PHOTO_KEEP_HOURS (now() in SQL, the transaction's start, as created_at).
// If anything fails after the upload, the object is removed again (best effort; an
// object left behind is a leak only, never a photo shown without its complaint).
//   409 photo_uploads_off    "Photo uploads are switched off for now. Please send the
//                            complaint without a photo."
//   503 photo_upload_failed  "The photo could not be saved. Try again, or send the
//                            complaint without it."
// `uploads` may be left out when there is no photo.
//
// Never log the description or the photo's name.
export async function createComplaint(
  db: Db,
  studentId: number,
  input: NewComplaint,
  limits: ComplaintLimits,
  uploads?: PhotoUploads,
): Promise<{ id: number }> {
  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  // Set once the photo is in storage and cleared at the commit; removed again if the
  // complaint is not saved.
  let uploadedPath: string | null = null;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // The student first, as on every path that changes a student. A second complaint
    // from the same student waits here until this one commits, then counts it.
    const student = await c.query<{ role: string; isActive: boolean }>(
      `SELECT role, is_active AS "isActive" FROM users WHERE id = $1 AND hostel_id = current_hostel_id() FOR UPDATE`,
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
       WHERE student_id = $1 AND hostel_id = current_hostel_id()`,
      [studentId, input.category],
    );
    const counts = rows[0];
    if (counts.categoryActive) throw categoryActive(input.category);
    if (counts.active >= limits.maxActive) throw tooManyActive(limits);
    if (counts.recent >= limits.maxNewPer24h) throw tooManyRecent(limits);

    const photo = input.photo ?? null;
    if (photo) {
      if (!uploads?.storage) throw photoUploadsOff();
      const usage = await getUsage(c, uploads.usageLimits, uploads.now);
      if (!usage.uploadsAllowed) throw photoUploadsOff();

      const path = newPhotoPath(photo.type);
      try {
        await uploads.storage.upload(path, photo.bytes, photo.type);
      } catch (err) {
        if (err instanceof StorageError) {
          throw new HttpError(
            503,
            "photo_upload_failed",
            "The photo could not be saved. Try again, or send the complaint without it.",
          );
        }
        throw err;
      }
      uploadedPath = path;
    }

    let complaintId: number;
    try {
      const inserted = await c.query<{ id: number }>(
        `INSERT INTO complaints (student_id, category, description,
                                 photo_path, photo_size_bytes, photo_expires_at)
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $4::text IS NULL THEN NULL ELSE now() + make_interval(hours => $6) END)
         RETURNING id`,
        [
          studentId,
          input.category,
          input.description,
          uploadedPath,
          photo ? photo.bytes.length : null,
          PHOTO_KEEP_HOURS,
        ],
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
    uploadedPath = null;

    return { id: complaintId };
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    if (uploadedPath !== null && uploads?.storage) {
      // Best effort: the student gets the original error either way.
      await uploads.storage.remove(uploadedPath).catch(() => undefined);
    }
    throw err;
  } finally {
    c.release(rollbackFailed);
  }
}

function photoUploadsOff(): HttpError {
  return new HttpError(
    409,
    "photo_uploads_off",
    "Photo uploads are switched off for now. Please send the complaint without a photo.",
  );
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
     WHERE student_id = $1 AND hostel_id = current_hostel_id()`,
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
    `SELECT count(*)::int AS total FROM complaints WHERE student_id = $1 AND hostel_id = current_hostel_id()`,
    [studentId],
  );

  const { rows } = await db.query<MyComplaintItem>(
    `SELECT ${MY_COMPLAINT_COLUMNS}
     FROM complaints
     WHERE student_id = $1 AND hostel_id = current_hostel_id()
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
     WHERE id = $1 AND student_id = $2 AND hostel_id = current_hostel_id()`,
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
     WHERE complaint_id = $1 AND hostel_id = current_hostel_id()
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

// ---- The owner's status moves (day 7) ----
// tests/complaintTransitions.test.ts describes STATUS_MOVES and checkStatusChange.
//
// Section 4, as decided on day 7: four statuses and six moves, all made by the owner.
//   open         -> in_progress, resolved, rejected
//   in_progress  -> resolved, rejected
//   resolved     -> open          ("reopen")
//   rejected     -> nothing (final)
// Any other pair, including a move to the same status, is illegal. Rejecting and reopening
// need a note; the other moves take one optionally. A note is at most OWNER_NOTE_MAX
// characters.

export type ComplaintPriority = "low" | "normal" | "high";

// Where each status may move to (the order within a list does not matter). The owner's
// screen offers exactly these moves.
export const STATUS_MOVES: Record<ComplaintStatus, readonly ComplaintStatus[]> = {
  open: ["in_progress", "resolved", "rejected"],
  in_progress: ["resolved", "rejected"],
  resolved: ["open"],
  rejected: [],
};

// The longest owner note, counted as the database counts characters (an emoji is one).
export const OWNER_NOTE_MAX = 500;

// A status as the owner reads it in a message ("in progress", not "in_progress").
const STATUS_WORDS: Record<ComplaintStatus, string> = {
  open: "open",
  in_progress: "in progress",
  resolved: "resolved",
  rejected: "rejected",
};

// Decides whether the owner may move a complaint from `from` to `to` with this note, before
// anything is written. `note` is as the request sent it (it may be missing, empty or padded
// with spaces); `from` and `to` are always valid statuses. Pure: no database, no clock.
//
// The note is trimmed (spaces, tabs and line breaks) first; an empty result counts as no
// note. Returns the trimmed note, or null when there is none.
//
// The refusals, checked in this order (status, code, message shown to the owner as-is):
//   409 illegal_transition   "A complaint that is <from> cannot be moved to <to>."
//   400 note_required        "Rejecting a complaint needs a note."   (any move to rejected)
//                            "Reopening a complaint needs a note."   (resolved -> open)
//   400 note_too_long        "A note can be at most <OWNER_NOTE_MAX> characters."
// <from> and <to> are written as the owner reads them: "open", "in progress", "resolved",
// "rejected". The length counts the trimmed note's characters ([...note].length), never
// note.length, which counts an emoji as 2.
export function checkStatusChange(
  from: ComplaintStatus,
  to: ComplaintStatus,
  note: string | null | undefined,
): string | null {
  if (!STATUS_MOVES[from].includes(to)) {
    throw new HttpError(
      409,
      "illegal_transition",
      `A complaint that is ${STATUS_WORDS[from]} cannot be moved to ${STATUS_WORDS[to]}.`,
    );
  }

  const trimmed = (note ?? "").trim();
  const text = trimmed === "" ? null : trimmed;

  if (text === null) {
    if (to === "rejected") {
      throw new HttpError(400, "note_required", "Rejecting a complaint needs a note.");
    }
    if (from === "resolved" && to === "open") {
      throw new HttpError(400, "note_required", "Reopening a complaint needs a note.");
    }
    return null;
  }

  // Code points, as char_length counts them: an emoji is one character, not two.
  if ([...text].length > OWNER_NOTE_MAX) {
    throw new HttpError(400, "note_too_long", `A note can be at most ${OWNER_NOTE_MAX} characters.`);
  }
  return text;
}

// ---- The owner's list (day 7) ----
// tests/ownerComplaints.test.ts describes it.

// Every filter is optional: null switches it off. The route checks the values with zod
// (and refuses `from` after `to`), so the service gets valid ones only.
export type OwnerComplaintFilters = {
  status: ComplaintStatus | null;
  priority: ComplaintPriority | null;
  category: ComplaintCategory | null;
  buildingId: number | null; // where the student lives now
  from: string | null; // 'YYYY-MM-DD', India's date, inclusive
  to: string | null; // 'YYYY-MM-DD', India's date, inclusive
  page: number; // from 1
  limit: number; // at most 50
};

// One row of the owner's list. Exactly these fields: no phone numbers (they stay on the
// student's profile) and no photo fields (day 8). `place` is where the student lives now
// (their current stay); roomNumber is null when they have a building but no room. `place`
// is null for a student with no current stay (moved out).
export type OwnerComplaintItem = {
  id: number;
  category: ComplaintCategory;
  description: string;
  status: ComplaintStatus;
  priority: ComplaintPriority;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  student: { id: number; name: string; isActive: boolean };
  place: { buildingName: string; roomNumber: string | null } | null;
};

// The owner's complaint list (sections 5 and 9): every student's complaints, moved-out
// students' included, one page at a time; and how many match in all.
//
// Order (section 5's default):
//   1. active ('open', 'in_progress') before finished ('resolved', 'rejected')
//   2. then priority: high, normal, low
//   3. then oldest first (created_at), ties by id (smaller first)
// The same rules order the finished ones among themselves.
//
// Filters, all combined with AND:
//   status, priority, category   equal to the value
//   buildingId                   the student's CURRENT stay is in that building (section 3:
//                                "the building filter joins through the student's current
//                                stay"). A student who has moved since raising it is found
//                                under the new building; one with no current stay is never
//                                found by this filter.
//   from, to                     the India date (Asia/Kolkata) on which the complaint was
//                                created is on or after `from` / on or before `to`. One
//                                created at 00:10 India time belongs to that India day,
//                                though in UTC (18:40) it is still the day before.
//
// `total` counts every match, so it is the same on every page, and a page past the end is
// empty. Every filter is a query parameter ($1, $2, ...), never text joined into the SQL.
export async function listOwnerComplaints(
  db: Queryable,
  filters: OwnerComplaintFilters,
): Promise<{ items: OwnerComplaintItem[]; total: number }> {
  const params = [
    filters.status,
    filters.priority,
    filters.category,
    filters.buildingId,
    filters.from,
    filters.to,
  ];

  // The current stay, if any: a student has at most one (stays_one_current_per_student).
  const fromWhere = `
     FROM complaints c
     JOIN users u ON u.id = c.student_id
     LEFT JOIN stays s ON s.student_id = c.student_id AND s.ended_on IS NULL
     LEFT JOIN buildings b ON b.id = s.building_id
     LEFT JOIN rooms r ON r.id = s.room_id
     WHERE c.hostel_id = current_hostel_id()
       AND ($1::text IS NULL OR c.status = $1)
       AND ($2::text IS NULL OR c.priority = $2)
       AND ($3::text IS NULL OR c.category = $3)
       AND ($4::bigint IS NULL OR s.building_id = $4)
       AND ($5::date IS NULL OR (c.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $5::date)
       AND ($6::date IS NULL OR (c.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $6::date)`;

  const { rows: counted } = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total ${fromWhere}`,
    params,
  );

  const { rows } = await db.query<{
    id: number;
    category: ComplaintCategory;
    description: string;
    status: ComplaintStatus;
    priority: ComplaintPriority;
    createdAt: Date;
    updatedAt: Date;
    resolvedAt: Date | null;
    studentId: number;
    studentName: string;
    studentIsActive: boolean;
    buildingName: string | null;
    roomNumber: string | null;
  }>(
    `SELECT c.id, c.category, c.description, c.status, c.priority,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.resolved_at AS "resolvedAt",
            u.id AS "studentId",
            u.name AS "studentName",
            u.is_active AS "studentIsActive",
            b.name AS "buildingName",
            r.room_number AS "roomNumber"
     ${fromWhere}
     ORDER BY (c.status IN ('open', 'in_progress')) DESC,
              CASE c.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
              c.created_at, c.id
     LIMIT $7 OFFSET $8`,
    [...params, filters.limit, (filters.page - 1) * filters.limit],
  );

  const items = rows.map(
    (row): OwnerComplaintItem => ({
      id: row.id,
      category: row.category,
      description: row.description,
      status: row.status,
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt,
      student: { id: row.studentId, name: row.studentName, isActive: row.studentIsActive },
      place: row.buildingName === null ? null : { buildingName: row.buildingName, roomNumber: row.roomNumber },
    }),
  );

  return { items, total: counted[0].total };
}

// ---- One complaint, as the owner sees it (day 7) ----
// tests/ownerComplaints.test.ts describes it.

// A row of the owner's list, plus the whole timeline (oldest entry first, as the student
// sees it) and the moves the owner may make from the current status: STATUS_MOVES[status],
// so the screen draws its buttons from the server and never keeps its own copy of the map.
export type OwnerComplaintDetail = OwnerComplaintItem & {
  events: ComplaintEventItem[];
  allowedMoves: readonly ComplaintStatus[];
};

// Any complaint by id: every student's, moved-out students' included.
//   404 complaint_not_found   "That complaint does not exist."   (the student's message)
// Timeline entries by created_at, ties by id. No phone numbers, no photo fields.
export async function getOwnerComplaint(db: Queryable, complaintId: number): Promise<OwnerComplaintDetail> {
  // The same joins as the list: the student, and their current stay if any.
  const { rows } = await db.query<{
    id: number;
    category: ComplaintCategory;
    description: string;
    status: ComplaintStatus;
    priority: ComplaintPriority;
    createdAt: Date;
    updatedAt: Date;
    resolvedAt: Date | null;
    studentId: number;
    studentName: string;
    studentIsActive: boolean;
    buildingName: string | null;
    roomNumber: string | null;
  }>(
    `SELECT c.id, c.category, c.description, c.status, c.priority,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.resolved_at AS "resolvedAt",
            u.id AS "studentId",
            u.name AS "studentName",
            u.is_active AS "studentIsActive",
            b.name AS "buildingName",
            r.room_number AS "roomNumber"
     FROM complaints c
     JOIN users u ON u.id = c.student_id
     LEFT JOIN stays s ON s.student_id = c.student_id AND s.ended_on IS NULL
     LEFT JOIN buildings b ON b.id = s.building_id
     LEFT JOIN rooms r ON r.id = s.room_id
     WHERE c.id = $1 AND c.hostel_id = current_hostel_id()`,
    [complaintId],
  );
  if (rows.length === 0) {
    throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
  }
  const row = rows[0];

  const { rows: events } = await db.query<ComplaintEventItem>(
    `SELECT kind, note,
            from_status AS "fromStatus",
            to_status AS "toStatus",
            created_at AS "createdAt"
     FROM complaint_events
     WHERE complaint_id = $1 AND hostel_id = current_hostel_id()
     ORDER BY created_at, id`,
    [complaintId],
  );

  return {
    id: row.id,
    category: row.category,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    student: { id: row.studentId, name: row.studentName, isActive: row.studentIsActive },
    place: row.buildingName === null ? null : { buildingName: row.buildingName, roomNumber: row.roomNumber },
    events,
    allowedMoves: STATUS_MOVES[row.status],
  };
}

// ---- The owner changes a complaint's status (day 7) ----
// tests/statusChange.test.ts describes it.

// What the owner's screen sends: the status the owner was looking at (`from`), the one
// they chose (`to`), and an optional note as typed (checkStatusChange trims and checks it).
export type StatusChangeInput = {
  from: ComplaintStatus;
  to: ComplaintStatus;
  note?: string | null;
};

// Moves a complaint from `from` to `to` for the owner (section 4), or refuses with
// nothing written. In ONE transaction:
//   1. checkStatusChange(from, to, note) decides the move and gives the note to store.
//   2. Find the complaint's student (404 if there is no such complaint) and lock that
//      student's users row (SELECT ... FOR UPDATE), BEFORE touching the complaint. See
//      "Locking" below: without it, a reopen racing a new complaint deadlocks.
//   3. UPDATE complaints SET status = to, updated_at = now(), resolved_at = now() when `to`
//      is 'resolved', otherwise NULL ... WHERE id = complaintId AND status = from.
//      The "AND status = from" is section 4's guard: of two changes made at once from the
//      same status, only one can match. No trigger sets updated_at or resolved_at, and
//      migration 009 requires resolved_at to be set exactly while the status is 'resolved'.
//   4. INSERT one complaint_events row: kind 'status_change', actor_id = ownerId,
//      from_status = from, to_status = to, note = the trimmed note or NULL.
//   5. notify(c, [the complaint's student], ...) with
//        type   'complaint_update'
//        title  "Your <category> complaint is now <to>."   (<to> as the owner reads it:
//               "open", "in progress", "resolved", "rejected")
//               "Your <category> complaint was reopened."  (resolved -> open)
//        body   null: the owner's note is never put in a notification, so a phone number
//               typed into a note can never reach one. The student reads it on the page.
//        link   "/complaints/<id>"
//      <category> as stored ("plumbing"). Nothing for the owner. notify() skips a moved-out
//      student, whose complaint the owner may still answer.
// After the commit, returns getOwnerComplaint(db, complaintId): the screen redraws from it.
//
// The refusals, checked in this order (status, code, message shown to the owner as-is):
//   409/400 from checkStatusChange (illegal_transition, note_required, note_too_long)
//   404 complaint_not_found  "That complaint does not exist."
//   409 status_changed       "This complaint has changed since you opened it. Reload it and
//                            try again."   (it exists, but its status is no longer `from`)
//   409 category_active      "The student already has an active <category> complaint, so
//                            this one cannot be reopened."
//                            (reopening hits the index complaints_one_active_per_category,
//                            because the student has since raised a new complaint in that
//                            category; turned into this refusal, never a 500)
//
// Locking (found by the race test on day 7): lock the student's users row first, as every
// path that changes a student's complaints does. Without it, a reopen and a new complaint
// in the same category deadlock: createComplaint holds the student's row and waits on the
// one-active-per-category index, which the reopen's UPDATE holds, while the reopen's
// notify() needs a share lock on that same student row (the notification's foreign key).
// With the lock first, one waits for the other and the loser gets its clean refusal
// (409 category_active here, 429 category_active from createComplaint). Never log the note.
export async function changeComplaintStatus(
  db: Db,
  ownerId: number,
  complaintId: number,
  input: StatusChangeInput,
): Promise<OwnerComplaintDetail> {
  // Validate the requested move and trim the note before opening a transaction.
  const note = checkStatusChange(input.from, input.to, input.note);

  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;
  let complaintCategory: ComplaintCategory | null = null;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // Read the student and category without locking the complaint. All complaint-changing
    // paths lock the student's user row first, which gives them a consistent lock order.
    const { rows: complaintRows } = await c.query<{
      studentId: number;
      category: ComplaintCategory;
    }>(
      `SELECT student_id AS "studentId", category
       FROM complaints
       WHERE id = $1 AND hostel_id = current_hostel_id()`,
      [complaintId],
    );

    if (complaintRows.length === 0) {
      throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
    }

    const complaint = complaintRows[0];
    complaintCategory = complaint.category;

    // Serialize status changes with new complaints for the same student.
    const { rows: studentRows } = await c.query<{ id: number }>(
      `SELECT id FROM users WHERE id = $1 AND hostel_id = current_hostel_id() FOR UPDATE`,
      [complaint.studentId],
    );

    if (studentRows.length === 0) {
      throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
    }

    const { rowCount } = await c.query(
      `UPDATE complaints
       SET status = $1,
           updated_at = now(),
           resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END
       WHERE id = $2 AND status = $3 AND hostel_id = current_hostel_id()`,
      [input.to, complaintId, input.from],
    );

    if (rowCount === 0) {
      throw new HttpError(
        409,
        "status_changed",
        "This complaint has changed since you opened it. Reload it and try again.",
      );
    }

    await c.query(
      `INSERT INTO complaint_events
         (complaint_id, actor_id, kind, from_status, to_status, note)
       VALUES ($1, $2, 'status_change', $3, $4, $5)`,
      [complaintId, ownerId, input.from, input.to, note],
    );

    const title =
      input.from === "resolved" && input.to === "open"
        ? `Your ${complaint.category} complaint was reopened.`
        : `Your ${complaint.category} complaint is now ${STATUS_WORDS[input.to]}.`;

    await notify(c, [complaint.studentId], {
      type: "complaint_update",
      title,
      body: null,
      link: `/complaints/${complaintId}`,
    });

    await c.query("COMMIT");
    transactionStarted = false;
  } catch (err) {
    if (transactionStarted) {
      try {
        await c.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }

    const pgErr = err as { code?: string; constraint?: string } | null;
    if (
      input.from === "resolved" &&
      input.to === "open" &&
      pgErr?.code === "23505" &&
      pgErr.constraint === "complaints_one_active_per_category" &&
      complaintCategory !== null
    ) {
      throw new HttpError(
        409,
        "category_active",
        `The student already has an active ${complaintCategory} complaint, so this one cannot be reopened.`,
      );
    }

    throw err;
  } finally {
    c.release(rollbackFailed);
  }

  // Read the committed state after releasing the transaction client.
  return getOwnerComplaint(db, complaintId);
}

// ---- The owner adds a note (day 7) ----
// tests/complaintNotes.test.ts describes it.

// Adds a one-way note from the owner to a complaint's timeline (sections 4 and 9), or
// refuses with nothing written. Allowed whatever the status, resolved and rejected
// included, so the owner can explain something later. In ONE transaction:
//   1. Check the note first, before any query: trimmed (spaces, tabs and line breaks), it
//      must not be empty and must be at most OWNER_NOTE_MAX characters, counted as the
//      database counts them ([...note].length).
//   2. Find the complaint's student (404 if there is no such complaint) and lock that
//      student's users row (SELECT ... FOR UPDATE), as changeComplaintStatus does, so every
//      path that writes a complaint's timeline takes its locks in the same order.
//   3. UPDATE complaints SET updated_at = now(): a note is an update the student sees.
//      Nothing else changes: not the status, the priority or resolved_at.
//   4. INSERT one complaint_events row: kind 'note', actor_id = ownerId, the trimmed note,
//      from_status and to_status NULL.
//   5. notify(c, [the complaint's student], ...) with
//        type   'complaint_update'
//        title  "There is a new note on your <category> complaint."   (category as stored)
//        body   null: the note itself never goes into a notification (no phone numbers)
//        link   "/complaints/<id>"
//      Nothing for the owner. notify() skips a moved-out student.
// After the commit, returns getOwnerComplaint(db, complaintId).
//
// The refusals, checked in this order (status, code, message shown to the owner as-is):
//   400 note_required        "A note cannot be empty."
//   400 note_too_long        "A note can be at most <OWNER_NOTE_MAX> characters."
//   404 complaint_not_found  "That complaint does not exist."
// Never log the note.
export async function addComplaintNote(
  db: Db,
  ownerId: number,
  complaintId: number,
  note: string | null | undefined,
): Promise<OwnerComplaintDetail> {
  // Check the note before opening a transaction.
  const text = (note ?? "").trim();
  if (text === "") {
    throw new HttpError(400, "note_required", "A note cannot be empty.");
  }
  // Code points, as char_length counts them: an emoji is one character, not two.
  if ([...text].length > OWNER_NOTE_MAX) {
    throw new HttpError(400, "note_too_long", `A note can be at most ${OWNER_NOTE_MAX} characters.`);
  }

  const c = await db.connect();
  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    await c.query("BEGIN");
    transactionStarted = true;

    // The student and category, without locking the complaint; then the student's row,
    // in the same lock order as changeComplaintStatus and createComplaint.
    const { rows: complaintRows } = await c.query<{
      studentId: number;
      category: ComplaintCategory;
    }>(
      `SELECT student_id AS "studentId", category
       FROM complaints
       WHERE id = $1 AND hostel_id = current_hostel_id()`,
      [complaintId],
    );

    if (complaintRows.length === 0) {
      throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
    }

    const complaint = complaintRows[0];

    await c.query(`SELECT id FROM users WHERE id = $1 AND hostel_id = current_hostel_id() FOR UPDATE`, [complaint.studentId]);

    // Only updated_at: the status, priority and resolved_at stay as they are.
    await c.query(`UPDATE complaints SET updated_at = now() WHERE id = $1 AND hostel_id = current_hostel_id()`, [complaintId]);

    await c.query(
      `INSERT INTO complaint_events (complaint_id, actor_id, kind, note)
       VALUES ($1, $2, 'note', $3)`,
      [complaintId, ownerId, text],
    );

    await notify(c, [complaint.studentId], {
      type: "complaint_update",
      title: `There is a new note on your ${complaint.category} complaint.`,
      body: null,
      link: `/complaints/${complaintId}`,
    });

    await c.query("COMMIT");
    transactionStarted = false;
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

  // Read the committed state after releasing the transaction client.
  return getOwnerComplaint(db, complaintId);
}

// ---- The owner sets a priority (day 7) ----
// tests/complaintPriority.test.ts describes it.

// Sets a complaint's priority (section 4: the owner sets it, students never see it), on
// any status, finished ones included; setting the priority it already has is fine. One
// statement: UPDATE complaints SET priority WHERE id. Nothing else is written, because
// anything else would show the student that something hidden changed:
//   - not updated_at (the student's list shows it),
//   - no timeline event (the student's timeline shows every event),
//   - no notification.
// No lock on the student's row: one row, no event, no notify() and no change to which
// complaints are active, so it cannot join the lock order of the other paths. Two changes
// at once: the last one wins. `priority` is checked by the route (zod) and the database.
// Returns getOwnerComplaint(db, complaintId).
//   404 complaint_not_found  "That complaint does not exist."
export async function setComplaintPriority(
  db: Queryable,
  complaintId: number,
  priority: ComplaintPriority,
): Promise<OwnerComplaintDetail> {
  const { rowCount } = await db.query(`UPDATE complaints SET priority = $2 WHERE id = $1 AND hostel_id = current_hostel_id()`, [
    complaintId,
    priority,
  ]);
  if (rowCount === 0) {
    throw new HttpError(404, "complaint_not_found", "That complaint does not exist.");
  }
  return getOwnerComplaint(db, complaintId);
}

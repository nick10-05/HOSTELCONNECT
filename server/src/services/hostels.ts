import { z } from "zod";
import { markHostel, type Db, type Queryable } from "../db";
import { HttpError } from "../lib/http";

// A hostel's address, /h/<slug>/ (multi-tenant phase 3a): 3 to 40 lowercase letters,
// digits and single hyphens, not starting or ending with a hyphen. The same rule as the
// hostels.slug check in migration 013.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const isSlug = (value: string) => SLUG_PATTERN.test(value) && !value.includes("--");

export const slugSchema = z.string().refine(isSlug, "is not a hostel address");

export type PublicHostel = { id: number; name: string; slug: string };

// The active hostel at this address, or null: none has it, it is malformed, or the hostel
// is suspended. hostels belongs to no hostel, so this runs outside withHostel. Callers
// answer all three null cases alike, so a suspension is not announced.
export async function activeHostelBySlug(db: Queryable, slug: string): Promise<PublicHostel | null> {
  if (!isSlug(slug)) return null;
  const { rows } = await db.query<PublicHostel>(
    "SELECT id::int AS id, name, slug FROM hostels WHERE slug = $1 AND status = 'active'",
    [slug],
  );
  return rows[0] ?? null;
}

// ---- Sign-up and the hostel's profile (multi-tenant phase 4a) ----

// Addresses no hostel may take: words a person could mistake for HostelConnect's own
// pages, or that later pages may need.
export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "assets", "billing", "contact", "dashboard", "help", "hostel", "hostels",
  "hostelconnect", "login", "logout", "new", "owner", "owners", "privacy", "register", "settings",
  "signin", "signup", "static", "status", "student", "students", "support", "terms", "www",
]);

export type SlugCheck = { available: true } | { available: false; reason: "invalid" | "reserved" | "taken" };

// Whether a hostel may take this address. `ownHostelId`: the hostel asking keeps its own.
export async function checkSlug(db: Queryable, slug: string, ownHostelId?: number): Promise<SlugCheck> {
  if (!isSlug(slug)) return { available: false, reason: "invalid" };
  if (RESERVED_SLUGS.has(slug)) return { available: false, reason: "reserved" };
  const { rows } = await db.query<{ id: number }>("SELECT id FROM hostels WHERE slug = $1", [slug]);
  if (rows.length > 0 && rows[0].id !== ownHostelId) return { available: false, reason: "taken" };
  return { available: true };
}

const SLUG_MESSAGES: Record<"invalid" | "reserved" | "taken", string> = {
  invalid: "The address must be 3 to 40 lowercase letters, digits and single hyphens.",
  reserved: "That address is kept for HostelConnect itself. Choose another.",
  taken: "Another hostel already uses that address. Choose another.",
};

async function requireSlug(db: Queryable, slug: string, ownHostelId?: number) {
  const check = await checkSlug(db, slug, ownHostelId);
  if (!check.available) {
    throw new HttpError(check.reason === "taken" ? 409 : 400, check.reason === "taken" ? "slug_taken" : "invalid_slug", SLUG_MESSAGES[check.reason]);
  }
}

const UNIQUE_VIOLATION = "23505";
const constraintOf = (err: unknown) =>
  (err as { code?: string }).code === UNIQUE_VIOLATION ? (err as { constraint?: string }).constraint : undefined;

export type NewHostel = {
  hostelName: string;
  slug: string;
  ownerName: string;
  // From Google: the verified email and the account's id.
  email: string;
  googleSub: string;
  termsVersion: string;
};

// Sign-up: a new hostel and its one owner, together or not at all. The owner signs in with
// Google only (no password) and has accepted `termsVersion` now. This is the only way an
// owner account is made, so every hostel made here has exactly one owner, and a Google
// account (unique across hostels) owns one hostel at most.
export async function createHostelWithOwner(db: Db, input: NewHostel): Promise<{ hostelId: number; ownerId: number }> {
  await requireSlug(db, input.slug);
  const c = await db.connect();
  let broken: Error | undefined;
  try {
    await c.query("BEGIN");
    try {
      const { rows } = await c.query<{ id: number }>("INSERT INTO hostels (name, slug) VALUES ($1, $2) RETURNING id", [
        input.hostelName,
        input.slug,
      ]);
      const hostelId = rows[0].id;
      // The owner row is the new hostel's: row-level security lets it in only so marked.
      await markHostel(c, hostelId);
      const owner = await c.query<{ id: number }>(
        `INSERT INTO users (hostel_id, role, name, email, password_hash, google_sub, must_change_password,
                            terms_version, terms_accepted_at)
         VALUES ($1, 'owner', $2, $3, NULL, $4, false, $5, now())
         RETURNING id`,
        [hostelId, input.ownerName, input.email, input.googleSub, input.termsVersion],
      );
      await c.query("COMMIT");
      return { hostelId, ownerId: owner.rows[0].id };
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      const constraint = constraintOf(err);
      if (constraint === "hostels_slug_key") throw new HttpError(409, "slug_taken", SLUG_MESSAGES.taken);
      if (constraint === "users_google_sub_key") {
        throw new HttpError(409, "already_signed_up", "That Google account already has a HostelConnect account. Sign in instead.");
      }
      throw err;
    }
  } finally {
    c.release(broken);
  }
}

// The owner renames their hostel, changes its address, or sets the day fees start (phase
// 5a). Runs inside withHostel: it can only ever change the hostel the transaction is
// marked with. The fees start date can be changed but not removed.
export async function updateHostelProfile(
  tx: Queryable,
  changes: { name?: string; slug?: string; feesStartDate?: string },
): Promise<{ name: string; slug: string | null }> {
  if (changes.slug !== undefined) {
    const { rows } = await tx.query<{ id: number }>("SELECT current_hostel_id() AS id");
    await requireSlug(tx, changes.slug, rows[0].id);
  }
  try {
    const { rows } = await tx.query<{ name: string; slug: string | null }>(
      `UPDATE hostels SET name = coalesce($1, name), slug = coalesce($2, slug),
                          fees_start_date = coalesce($3::date, fees_start_date)
       WHERE id = current_hostel_id()
       RETURNING name, slug`,
      [changes.name ?? null, changes.slug ?? null, changes.feesStartDate ?? null],
    );
    return rows[0];
  } catch (err) {
    if (constraintOf(err) === "hostels_slug_key") throw new HttpError(409, "slug_taken", SLUG_MESSAGES.taken);
    throw err;
  }
}

// ---- Each hostel's settings and limits (multi-tenant phase 5a) ----

export type HostelSettings = {
  name: string;
  slug: string | null;
  // The first day fee rows are created for (YYYY-MM-DD); null: fees are not tracked yet.
  feesStartDate: string | null;
  limits: { students: number; buildings: number };
  usage: { students: number; buildings: number };
};

// The owner's view of their own hostel, inside withHostel. "Students" are current ones:
// active accounts, the ones the limit counts.
export async function getHostelSettings(tx: Queryable): Promise<HostelSettings> {
  const { rows } = await tx.query<{
    name: string;
    slug: string | null;
    feesStartDate: string | null;
    studentLimit: number;
    buildingLimit: number;
    students: number;
    buildings: number;
  }>(
    `SELECT h.name, h.slug, to_char(h.fees_start_date, 'YYYY-MM-DD') AS "feesStartDate",
            h.student_limit AS "studentLimit", h.building_limit AS "buildingLimit",
            (SELECT count(*)::int FROM users
              WHERE hostel_id = h.id AND role = 'student' AND is_active) AS students,
            (SELECT count(*)::int FROM buildings WHERE hostel_id = h.id) AS buildings
       FROM hostels h
      WHERE h.id = current_hostel_id()`,
  );
  const r = rows[0];
  return {
    name: r.name,
    slug: r.slug,
    feesStartDate: r.feesStartDate,
    limits: { students: r.studentLimit, buildings: r.buildingLimit },
    usage: { students: r.students, buildings: r.buildings },
  };
}

// "1 building", "20 buildings".
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// Locks the transaction's hostel row until the transaction ends, and returns its limits.
// Every check below takes this lock first, so two admissions at once cannot both take the
// last place: the second waits, then counts the first.
async function lockedLimits(tx: Queryable): Promise<{ studentLimit: number; buildingLimit: number }> {
  const { rows } = await tx.query<{ studentLimit: number; buildingLimit: number }>(
    `SELECT student_limit AS "studentLimit", building_limit AS "buildingLimit"
       FROM hostels WHERE id = current_hostel_id() FOR NO KEY UPDATE`,
  );
  if (!rows[0]) throw new Error("no hostel is marked for this transaction");
  return rows[0];
}

// Before a student becomes current (admitted, imported, reactivated or let back in): the
// hostel must have room under its student limit. Call it inside the transaction that
// makes the student current.
export async function requireStudentPlace(tx: Queryable): Promise<void> {
  const { studentLimit } = await lockedLimits(tx);
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users
      WHERE hostel_id = current_hostel_id() AND role = 'student' AND is_active`,
  );
  if (rows[0].n >= studentLimit) {
    throw new HttpError(
      409,
      "student_limit_reached",
      `Your hostel has reached its limit of ${count(studentLimit, "current student")}. Move out students who have left, or ask HostelConnect for a higher limit.`,
    );
  }
}

// Before a building is added: the hostel must have room under its building limit.
export async function requireBuildingPlace(tx: Queryable): Promise<void> {
  const { buildingLimit } = await lockedLimits(tx);
  const { rows } = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM buildings WHERE hostel_id = current_hostel_id()",
  );
  if (rows[0].n >= buildingLimit) {
    throw new HttpError(
      409,
      "building_limit_reached",
      `Your hostel has reached its limit of ${count(buildingLimit, "building")}. Ask HostelConnect for a higher limit.`,
    );
  }
}

// FEES_START_DATE, the setting from before each hostel had its own date, becomes hostel
// #1's date: at startup it is written to hostel #1 if hostel #1 has none yet. From then on
// the hostel's own date counts, and the owner changes it in Settings. Returns whether it
// was written.
export async function adoptFeesStartDate(db: Queryable, date: string | undefined): Promise<boolean> {
  if (!date) return false;
  const { rowCount } = await db.query(
    "UPDATE hostels SET fees_start_date = $1::date WHERE id = 1 AND fees_start_date IS NULL",
    [date],
  );
  return rowCount === 1;
}

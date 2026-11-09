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

// The owner renames their hostel or changes its address. Runs inside withHostel: it can
// only ever change the hostel the transaction is marked with.
export async function updateHostelProfile(
  tx: Queryable,
  changes: { name?: string; slug?: string },
): Promise<{ name: string; slug: string | null }> {
  if (changes.slug !== undefined) {
    const { rows } = await tx.query<{ id: number }>("SELECT current_hostel_id() AS id");
    await requireSlug(tx, changes.slug, rows[0].id);
  }
  try {
    const { rows } = await tx.query<{ name: string; slug: string | null }>(
      `UPDATE hostels SET name = coalesce($1, name), slug = coalesce($2, slug)
       WHERE id = current_hostel_id()
       RETURNING name, slug`,
      [changes.name ?? null, changes.slug ?? null],
    );
    return rows[0];
  } catch (err) {
    if (constraintOf(err) === "hostels_slug_key") throw new HttpError(409, "slug_taken", SLUG_MESSAGES.taken);
    throw err;
  }
}

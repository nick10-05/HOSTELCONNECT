import { z } from "zod";
import type { Queryable } from "../db";

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

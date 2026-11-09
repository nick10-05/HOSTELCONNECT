import { apiFetch } from "./client";

// A hostel as its public pages know it (multi-tenant phase 3a). The slug is the hostel's
// address, /h/<slug>/; null only for a hostel that has not chosen one yet.
export type Hostel = { name: string; slug: string | null };

// GET /api/hostels/:slug, public: the hostel at this address. Unknown, malformed or
// suspended: 404 "hostel_not_found".
export async function getHostel(slug: string): Promise<Hostel> {
  const { hostel } = await apiFetch<{ hostel: Hostel }>(`/api/hostels/${encodeURIComponent(slug)}`);
  return hostel;
}

// PATCH /api/hostel, owners only (phase 4a): rename the owner's own hostel or change its
// address. Address taken: 409 "slug_taken"; not allowed: 400 "invalid_slug".
export async function updateHostel(changes: { name?: string; slug?: string }): Promise<Hostel> {
  const { hostel } = await apiFetch<{ hostel: Hostel }>("/api/hostel", { method: "PATCH", body: changes });
  return hostel;
}

// Where a hostel's students sign in.
export const signInPath = (slug: string) => `/h/${slug}/login`;
export const requestAccessPath = (slug: string) => `/h/${slug}/request-access`;

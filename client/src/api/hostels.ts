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

// Where a hostel's students sign in.
export const signInPath = (slug: string) => `/h/${slug}/login`;
export const requestAccessPath = (slug: string) => `/h/${slug}/request-access`;

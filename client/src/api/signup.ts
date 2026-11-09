import { apiFetch } from "./client";
import type { User } from "./auth";

// Sign-up (multi-tenant phase 4a). It starts at Google ("Sign in with Google" on the
// sign-in page): a Google account no owner has comes back to /signup with a sign-up ticket
// (an httpOnly cookie this page cannot see), and these use it.

// GET /api/signup: the email the new account will have, and the version of the terms to
// accept. Not started (no ticket, or it ran out): 401 "signup_not_started"; sign-up closed:
// 403 "signups_closed".
export async function getSignup(): Promise<{ email: string; termsVersion: string }> {
  return apiFetch("/api/signup");
}

export type SlugCheck = { available: true } | { available: false; reason: "invalid" | "reserved" | "taken" };

// GET /api/signup/slug: whether a hostel may take this address.
export async function checkSlug(slug: string): Promise<SlugCheck> {
  return apiFetch(`/api/signup/slug?slug=${encodeURIComponent(slug)}`);
}

export type SignupForm = { ownerName: string; hostelName: string; slug: string; termsVersion: string };

// POST /api/signup: makes the hostel and its owner and signs the owner in. Address taken:
// 409 "slug_taken"; terms changed since the page loaded: 409 "terms_changed"; this Google
// account already has a hostel: 409 "already_signed_up".
export async function signUp(form: SignupForm): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/api/signup", { method: "POST", body: { ...form, acceptTerms: true } });
  return user;
}

// The rule of the server's slug check: 3 to 40 lowercase letters, digits and single
// hyphens, starting and ending with a letter or digit.
export const SLUG_MAX = 40;
export const isSlug = (s: string) => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) && !s.includes("--");

// An address made from the hostel's name: "Sri Sai Boys' Hostel" -> "sri-sai-boys-hostel".
export function suggestSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

// What to say about an address that cannot be had.
export const SLUG_PROBLEMS: Record<"invalid" | "reserved" | "taken", string> = {
  invalid: "Use 3 to 40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.",
  reserved: "That address is kept for HostelConnect itself. Choose another.",
  taken: "Another hostel has that address. Choose another.",
};

import { apiFetch } from "./client";
import type { Hostel } from "./hostels";

// What the server returns for the logged-in user. The auth routes (next server
// step) must answer with exactly this shape.
export type User = {
  id: number;
  name: string;
  role: "student" | "owner";
  mustChangePassword: boolean;
};

// POST /api/auth/login: sets the session cookie and returns the user. `hostel` is the
// slug of the sign-in page's address, which every sign-in names (phase 6).
// Wrong email or password: 401 "invalid_credentials"; too many attempts: 429.
export async function login(email: string, password: string, hostel: string): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: { hostel, email, password },
  });
  return user;
}

// How the account signs in (phase 3b): with a linked Google account, a password, or both.
export type Account = { googleLinked: boolean; hasPassword: boolean };

// GET /api/auth/me: the current user, their hostel and how they sign in, or a 401
// ApiError when not logged in.
export async function me(): Promise<{ user: User; hostel: Hostel | null; account: Account | null }> {
  const { user, hostel, account } = await apiFetch<{ user: User; hostel?: Hostel; account?: Account }>("/api/auth/me");
  return { user, hostel: hostel ?? null, account: account ?? null };
}

// GET /api/auth/options: whether "Sign in with Google" is set up on this server, and
// whether new hostels may sign up (phase 4a).
export async function authOptions(): Promise<{ google: boolean; signupsOpen: boolean }> {
  const { google, signupsOpen } = await apiFetch<{ google?: boolean; signupsOpen?: boolean }>("/api/auth/options");
  return { google: google === true, signupsOpen: google === true && signupsOpen === true };
}

// POST /api/auth/remove-password: an owner with Google linked drops the password.
// Wrong password: 400 "wrong_password"; Google not linked: 400 "google_not_linked".
export async function removePassword(currentPassword: string): Promise<void> {
  await apiFetch("/api/auth/remove-password", { method: "POST", body: { currentPassword } });
}

// POST /api/auth/change-password: returns the user with mustChangePassword false.
// Wrong current password: 400 "wrong_password"; same as current: 400 "same_password".
export async function changePassword(currentPassword: string, newPassword: string): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
  return user;
}

// POST /api/auth/logout: clears the session cookie.
export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

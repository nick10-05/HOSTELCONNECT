import { apiFetch } from "./client";

// What the server returns for the logged-in user. The auth routes (next server
// step) must answer with exactly this shape.
export type User = {
  id: number;
  name: string;
  role: "student" | "owner";
  mustChangePassword: boolean;
};

// POST /api/auth/login: sets the session cookie and returns the user.
// Wrong email or password: 401 "invalid_credentials"; too many attempts: 429.
export async function login(email: string, password: string): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return user;
}

// GET /api/auth/me: the current user, or a 401 ApiError when not logged in.
export async function me(): Promise<User> {
  const { user } = await apiFetch<{ user: User }>("/api/auth/me");
  return user;
}

// POST /api/auth/logout: clears the session cookie.
export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

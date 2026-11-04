import { apiFetch } from "./client";

// Rejoin requests. Shapes match server/src/routes/rejoin.ts.

// POST /api/rejoin-requests, public. Returns the server's sentence, which is the same
// whoever the email belongs to. Refusals arrive as ApiError: 400 "invalid_input",
// 429 "rate_limited".
export async function requestAccess(email: string, message: string): Promise<string> {
  const answer = await apiFetch<{ message: string }>("/api/rejoin-requests", {
    method: "POST",
    body: { email, message },
  });
  return answer.message;
}

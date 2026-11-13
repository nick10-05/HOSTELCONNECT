import jwt from "jsonwebtoken";

export type Role = "student" | "owner";

// sessionVersion: the account's users.session_version when the session was signed
// (migration 023). The database raises it when the password changes, and requireAuth then
// refuses every session signed before. A token from before migration 023 has none: 0.
export type SessionClaims = { userId: number; role: Role; sessionVersion?: number };

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function signSession(claims: SessionClaims, secret: string): string {
  return jwt.sign(
    {
      userId: claims.userId,
      role: claims.role,
      sv: claims.sessionVersion ?? 0,
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: SESSION_TTL_SECONDS,
    }
  );
}

export function verifySession(
  token: string,
  secret: string
): Required<SessionClaims> | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    });

    if (
      typeof payload === "string" ||
      typeof payload.userId !== "number" ||
      (payload.role !== "student" && payload.role !== "owner") ||
      (payload.sv !== undefined && !Number.isSafeInteger(payload.sv))
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      role: payload.role,
      sessionVersion: payload.sv ?? 0,
    };
  } catch {
    return null;
  }
}

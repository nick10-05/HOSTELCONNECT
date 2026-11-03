import jwt from "jsonwebtoken";

export type Role = "student" | "owner";

export type SessionClaims = { userId: number; role: Role };

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function signSession(claims: SessionClaims, secret: string): string {
  return jwt.sign(
    {
      userId: claims.userId,
      role: claims.role,
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
): SessionClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    });

    if (
      typeof payload === "string" ||
      typeof payload.userId !== "number" ||
      (payload.role !== "student" && payload.role !== "owner")
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      role: payload.role,
    };
  } catch {
    return null;
  }
}
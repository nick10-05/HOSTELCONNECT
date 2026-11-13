import type { Request, RequestHandler } from "express";

import { withHostel, type Db } from "../db";

import { verifySession, type Role } from "../lib/token";

export const SESSION_COOKIE = "hc_session";

export type AuthUser = {
  id: number;
  // The user's hostel, from their row in the database (never from the token or the
  // request). Every query about hostel data runs inside withHostel(db, hostelId, ...).
  hostelId: number;
  role: Role;
  mustChangePassword: boolean;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type AuthDeps = { db: Db; jwtSecret: string };

export type AuthOptions = {
  allowTemporaryPassword?: boolean;
};

export function requireAuth(
  deps: AuthDeps,
  options: AuthOptions = {}
): RequestHandler {
  return async (req, res, next) => {
    try {
      // 1. Read session cookie
      const token = req.cookies?.[SESSION_COOKIE];

      if (!token) {
        res.status(401).json({
          error: {
            code: "unauthenticated",
            message: "Authentication required",
          },
        });
        return;
      }

      // 2. Verify JWT
      const claims = verifySession(token, deps.jwtSecret);

      if (!claims) {
        res.status(401).json({
          error: {
            code: "unauthenticated",
            message: "Invalid or expired session",
          },
        });
        return;
      }

      // 3. Load current user from database
      // Through auth_user_by_id (migration 014): the session names a user, not a hostel,
      // so this lookup sees past the hostel boundary, and returns nothing else.
      const result = await deps.db.query<{
        id: number;
        hostel_id: number;
        role: Role;
        must_change_password: boolean;
        is_active: boolean;
        hostel_active: boolean;
        // Missing only before migration 023 is applied.
        session_version?: number;
      }>("SELECT * FROM auth_user_by_id($1)", [claims.userId]);

      const user = result.rows[0];

      // 4. Check the user exists and is active, in a hostel that is not suspended
      // A session signed before the password last changed has ended (migration 023).
      if (!user || !user.is_active || !user.hostel_active || claims.sessionVersion !== (user.session_version ?? 0)) {
        res.status(401).json({
          error: {
            code: "unauthenticated",
            message: "User not found or inactive",
          },
        });
        return;
      }

      // 5. Check temporary password restriction
      if (
        user.must_change_password &&
        options.allowTemporaryPassword !== true
      ) {
        res.status(403).json({
          error: {
            code: "password_change_required",
            message: "You must change your temporary password",
          },
        });
        return;
      }

      // 6. Attach database user to request
      req.user = {
        id: user.id,
        hostelId: user.hostel_id,
        role: user.role,
        mustChangePassword: user.must_change_password,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({
        error: {
          code: "unauthenticated",
          message: "Authentication required",
        },
      });
      return;
    }

    if (req.user.role !== role) {
      res.status(403).json({
        error: {
          code: "forbidden",
          message: "You do not have permission to access this resource",
        },
      });
      return;
    }

    next();
  };
}
// For routes: runs fn inside withHostel for the signed-in user's hostel (multi-tenant
// phase 2b). Pass `tx` to services in place of db. Only after requireAuth, which sets
// req.user.hostelId from the database; the hostel never comes from the request itself.
// The answer is sent after this returns, so it is sent only once the work is committed.
export function hostelWork(db: Db) {
  return <T>(req: Request, fn: (tx: Db) => Promise<T>): Promise<T> => {
    if (!req.user) throw new Error("hostelWork runs only after requireAuth");
    return withHostel(db, req.user.hostelId, fn);
  };
}

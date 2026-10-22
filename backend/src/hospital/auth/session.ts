import type { Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { logSecurityEvent } from "../../common/utils/securityLog.js";
import type { Database } from "../db.js";
import { AppError, forbidden, unauthorized } from "../shared/errors.js";
// (security events for refusals are written by the /api/v1 error handler, so they are logged once)

export const STAFF_ROLES = ["front_office", "doctor", "nurse", "pharmacist", "biller", "housekeeping", "lab", "admin"] as const;
export type StaffRoleName = (typeof STAFF_ROLES)[number];

/** The signed-in staff member, as the hospital modules see them (attached to every /api/v1 request as req.staff). */
export interface StaffSession {
  /** Staff id: what visits, bills, rosters and payslips refer to. */
  id: string;
  /** The login (User) behind it. */
  userId: string;
  name: string;
  role: StaffRoleName;
  department: string;
  email: string;
  /** The sign-in name. Logins are e-mail addresses in this application; OSHealth's screens call it the username. */
  username: string;
  mustChangePassword: boolean;
  facilityId: string;
  facilityName: string;
  /** The hospital's HFR id (OSHealth called it the hospital code). */
  facilityCode: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffSession;
    }
  }
}

interface SessionRow {
  userId: string;
  email: string;
  userName: string;
  userRole: StaffRoleName;
  userActive: boolean;
  tokenVersion: number;
  mustChangePassword: boolean;
  facilityId: string;
  facilityName: string;
  facilityStatus: string;
  hfrId: string;
  staffId: string | null;
  staffName: string | null;
  staffRole: StaffRoleName | null;
  department: string | null;
  staffActive: boolean | null;
}

export const hospitalSuspended = () =>
  new AppError(403, "HOSPITAL_SUSPENDED", "Access for this hospital is switched off. Please contact the people who run this system.");

/** Reads the access token the staff login set (cookie), or a bearer token. */
export function tokenOf(req: Request): string | undefined {
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.accessToken;
  if (typeof cookie === "string" && cookie) return cookie;
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

/**
 * The person behind a login, looked up on every request so that deactivating someone, removing their login, changing their
 * password or switching their hospital off takes effect at once. A login without a staff record (made before staff records
 * existed) gets one here, as an administrator, which is what such logins effectively were.
 */
export async function loadStaffSession(db: Database, userId: string, tokenVersion: number): Promise<StaffSession> {
  const row = await db.platform.queryOne<SessionRow>(
    `/* cross-facility: looks up the signed-in login by its own id, before its hospital is known */
     SELECT u.id AS "userId", u.email, u.name AS "userName", u.role::text AS "userRole", u.active AS "userActive", u."tokenVersion",
            u."mustChangePassword", u."facilityId", f.name AS "facilityName", f.status AS "facilityStatus", f."hfrId",
            s.id AS "staffId", s.name AS "staffName", s.role::text AS "staffRole", s.department, s.active AS "staffActive"
       FROM "User" u JOIN "Facility" f ON f.id = u."facilityId" LEFT JOIN "Staff" s ON s."userId" = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const ended = () => unauthorized("Your session has ended. Please sign in again.");
  if (!row || !row.userActive || row.tokenVersion !== tokenVersion || row.staffActive === false) throw ended();
  if (row.facilityStatus !== "active") throw hospitalSuspended();

  let staff = row.staffId ? { id: row.staffId, name: row.staffName!, role: row.staffRole!, department: row.department! } : null;
  if (!staff) {
    staff = await db.platform.queryOne<{ id: string; name: string; role: StaffRoleName; department: string }>(
      `/* cross-facility: the hospital is the login's own, given explicitly */
       INSERT INTO "Staff" ("facilityId", "userId", name, role, department) VALUES ($1, $2, $3, $4, 'Administration')
       ON CONFLICT ("userId") DO UPDATE SET "userId" = EXCLUDED."userId"
       RETURNING id, name, role::text AS role, department`,
      [row.facilityId, row.userId, row.userName, row.userRole],
    );
  }

  return {
    id: staff!.id,
    userId: row.userId,
    name: staff!.name,
    role: staff!.role,
    department: staff!.department,
    email: row.email,
    username: row.email,
    mustChangePassword: row.mustChangePassword,
    facilityId: row.facilityId,
    facilityName: row.facilityName,
    facilityCode: row.hfrId,
  };
}

/**
 * Requires a signed-in staff member (the login cookie set by POST /api/user/admin/login, or a bearer token) and runs the rest
 * of the request inside their hospital's scope: from here on every :fid in hospital SQL is that hospital and nothing else.
 * Until a new or reset password has been changed, only the routes listed in `allowWhilePasswordChangeDue` are open.
 */
export function requireStaff(db: Database, options: { allowWhilePasswordChangeDue?: (req: Request) => boolean } = {}): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = tokenOf(req);
      if (!token) {
        logSecurityEvent("AUTH_TOKEN_MISSING", req);
        throw unauthorized();
      }
      let payload: { id?: unknown; tv?: unknown };
      try {
        // Only the algorithm we sign with is accepted (rules out "alg: none" and algorithm-swap tokens).
        payload = jwt.verify(token, process.env.USER_ACCESS_TOKEN_SECRET!, { algorithms: ["HS256"] }) as typeof payload;
      } catch (error) {
        logSecurityEvent("AUTH_TOKEN_INVALID", req, { reason: error instanceof jwt.TokenExpiredError ? "expired" : "invalid" });
        throw unauthorized("Your session has ended. Please sign in again.");
      }
      if (typeof payload.id !== "string") throw unauthorized("Your session has ended. Please sign in again.");

      const staff = await loadStaffSession(db, payload.id, typeof payload.tv === "number" ? payload.tv : 0);
      if (staff.mustChangePassword && !options.allowWhilePasswordChangeDue?.(req)) {
        throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Please choose a new password before continuing.");
      }
      req.staff = staff;
      db.inFacility(staff.facilityId, () => next());
    } catch (error) {
      next(error);
    }
  };
}

/** Allows only the listed roles. Use after requireStaff. */
export function requireRole(...roles: StaffRoleName[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.staff) return next(unauthorized());
    next(roles.includes(req.staff.role) ? undefined : forbidden()); // the error handler logs the refusal as a security event
  };
}

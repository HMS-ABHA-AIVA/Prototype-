import bcrypt from "bcrypt";
import { Router, type CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { rateLimit } from "../../common/middlewares/rateLimit.middleware.js";
import { logSecurityEvent } from "../../common/utils/securityLog.js";
import type { HospitalContext } from "../context.js";
import { recordAudit } from "../shared/audit.js";
import { badRequest } from "../shared/errors.js";
import { staffOf } from "../shared/http.js";
import { parse } from "../shared/validate.js";
import { BCRYPT_ROUNDS, passwordProblem } from "./accounts.js";
import { requireStaff } from "./session.js";

/** The cookie the staff login sets (modules/users/admin), so a password change can hand out the new session the same way. */
export const accessCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  maxAge: 2 * 60 * 60 * 1000,
});

export const signAccessToken = (user: { id: string; email: string; facilityId: string }, tokenVersion: number) =>
  jwt.sign({ id: user.id, email: user.email, facilityId: user.facilityId, tv: tokenVersion }, process.env.USER_ACCESS_TOKEN_SECRET!, {
    expiresIn: "2h",
    algorithm: "HS256",
  });

const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });
const forgotSchema = z
  .object({ email: z.string().trim().max(254).optional(), username: z.string().trim().max(254).optional() })
  .refine((v) => !!(v.email || v.username), { message: "Enter the e-mail address you sign in with", path: ["email"] });

/**
 * /api/v1/auth: who am I, change my password, and "I forgot my password". Signing in and out is POST /api/user/admin/login
 * and /logout (one login for the whole application).
 */
export function authRouter({ db, env }: HospitalContext): Router {
  const router = Router();
  // These two must work while a new password is still due: they are how the person gets out of that state.
  const signedIn = requireStaff(db, { allowWhilePasswordChangeDue: () => true });

  router.get("/me", signedIn, (req, res) => {
    res.json({ user: staffOf(req) });
  });

  router.post("/change-password", signedIn, async (req, res) => {
    const staff = staffOf(req);
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    const user = await db.queryOne<{ id: string; email: string; facilityId: string; passwordHash: string; tokenVersion: number }>(
      `SELECT id, email, "facilityId", "passwordHash", "tokenVersion" FROM "User" WHERE "facilityId" = :fid AND id = $1`,
      [staff.userId],
    );
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest("The current password is not correct");
    const problem = passwordProblem(user.email, newPassword);
    if (problem) throw badRequest(problem);
    if (newPassword === currentPassword) throw badRequest("Choose a password different from the current one");

    const version = user.tokenVersion + 1;
    await db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE "User" SET "passwordHash" = $2, "mustChangePassword" = false, "resetRequestedAt" = NULL, "tokenVersion" = $3, "updatedAt" = now()
          WHERE "facilityId" = :fid AND id = $1`,
        [user.id, await bcrypt.hash(newPassword, BCRYPT_ROUNDS), version],
      );
      // Every other session of this login ends (the version changed); this one continues with a fresh cookie.
      await tx.execute(`DELETE FROM "UserRefreshToken" WHERE "userId" = $1 AND EXISTS (SELECT 1 FROM "User" WHERE "facilityId" = :fid AND id = $1)`, [user.id]);
      await recordAudit(tx, staff.name, "Password Changed", "");
    });
    logSecurityEvent("PASSWORD_CHANGED", req);
    res.cookie("accessToken", signAccessToken(user, version), accessCookieOptions());
    res.json({ ok: true, user: { ...staff, mustChangePassword: false } });
  });

  // "I forgot my password": flags the login for an administrator (the Staff Access screen lists them). It always answers the
  // same, so it cannot be used to find out which e-mail addresses have a login; a tight limit stops it flooding the list.
  const forgotLimit = env.rateLimitEnabled
    ? rateLimit({ windowMs: 60 * 60_000, max: 10, key: (req) => `forgot-ip:${req.ip}`, message: "Too many requests. Please try again later." })
    : (_req: unknown, _res: unknown, next: () => void) => next();
  router.post("/forgot-password", forgotLimit, async (req, res) => {
    const input = parse(forgotSchema, req.body);
    const login = (input.email ?? input.username ?? "").toLowerCase();
    if (login) {
      const user = await db.platform.queryOne<{ facilityId: string; name: string }>(
        `/* cross-facility: the login is found by e-mail before its hospital is known */
         UPDATE "User" u SET "resetRequestedAt" = now()
          WHERE lower(u.email) = $1 AND u.active
            AND EXISTS (SELECT 1 FROM "Facility" f WHERE f.id = u."facilityId" AND f.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s."userId" = u.id AND NOT s.active)
         RETURNING u."facilityId", u.name`,
        [login],
      );
      if (user) await db.inFacility(user.facilityId, () => recordAudit(db, user.name, "Password Reset Requested", login));
    }
    res.status(202).json({ message: "If that e-mail address has a login, an administrator has been asked to reset the password." });
  });

  return router;
}

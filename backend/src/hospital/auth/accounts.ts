import bcrypt from "bcrypt";
import { z } from "zod";
import { newPasswordSchema, rejectWeakPassword } from "../../common/validators/password.js";
import type { Queryable } from "../db.js";
import { recordAudit } from "../shared/audit.js";
import { AppError, badRequest, notFound } from "../shared/errors.js";

/**
 * Staff logins (the User table) managed from the hospital side: an administrator gives a staff member a login, resets a
 * forgotten password or removes access. The sign-in itself is POST /api/user/admin/login (modules/users/admin), which applies
 * the same safeguards: five wrong passwords lock the login for LOCK_MINUTES, a new or reset password must be changed at the
 * next sign-in, and raising tokenVersion ends every session the login holds.
 */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const BCRYPT_ROUNDS = 12;

/** The new-password policy of the whole application (length, letters and digits, weak and e-mail-based passwords refused). */
export function passwordProblem(email: string, password: string): string | null {
  const result = newPasswordSchema.safeParse(password);
  if (!result.success) return result.error.issues[0]?.message ?? "The password is not strong enough";
  const ctx = { issues: [] as { message: string }[], addIssue: (issue: { message: string }) => ctx.issues.push(issue) };
  rejectWeakPassword({ email, password }, ctx as unknown as z.RefinementCtx);
  return ctx.issues[0]?.message ?? null;
}

const email = z.email("Enter a valid e-mail address").max(254, "The e-mail address is too long").transform((v) => v.trim().toLowerCase());
export const loginSchema = z
  .object({
    // OSHealth's screens called the sign-in name "username"; logins here are e-mail addresses. Either key is accepted.
    email: email.optional(),
    username: email.optional(),
    password: z.string().min(1).max(128),
  })
  .refine((v) => v.email || v.username, { path: ["email"], message: "Enter the e-mail address the person will sign in with" })
  .transform((v): { email: string; password: string } => ({ email: v.email ?? v.username ?? "", password: v.password }));

/**
 * Gives a staff member a login, or resets theirs. The person must choose their own password at the next sign-in, and any
 * session they had ends. Must run inside the hospital's scope (the staff member must belong to it).
 */
export async function setLogin(tx: Queryable, staffId: string, loginEmail: string, password: string, actor: string): Promise<void> {
  const problem = passwordProblem(loginEmail, password);
  if (problem) throw badRequest(problem);
  const staff = await tx.queryOne<{ name: string; role: string; userId: string | null; active: boolean }>(
    `SELECT name, role::text AS role, "userId", active FROM "Staff" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`,
    [staffId],
  );
  if (!staff) throw notFound("Staff member");
  const taken = await tx.queryOne(
    `/* cross-facility: e-mail logins are unique across the whole installation */ SELECT 1 FROM "User" WHERE lower(email) = $1 AND id IS DISTINCT FROM $2`,
    [loginEmail, staff.userId],
  );
  if (taken) throw new AppError(409, "CONFLICT", "That e-mail address is already used by another login");

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  if (staff.userId) {
    await tx.execute(
      `UPDATE "User" SET email = $2, "passwordHash" = $3, name = $4, role = $5::"StaffRole", active = true, "mustChangePassword" = true, "failedLogins" = 0,
              "lockedUntil" = NULL, "resetRequestedAt" = NULL, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now()
        WHERE "facilityId" = :fid AND id = $1`,
      [staff.userId, loginEmail, hash, staff.name, staff.role],
    );
  } else {
    const user = await tx.queryOne<{ id: string }>(
      `INSERT INTO "User" (id, "facilityId", name, email, "passwordHash", role, "mustChangePassword", "updatedAt")
       VALUES (gen_random_uuid()::text, :fid, $1, $2, $3, $4::"StaffRole", true, now()) RETURNING id`,
      [staff.name, loginEmail, hash, staff.role],
    );
    await tx.execute(`UPDATE "Staff" SET "userId" = $2, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1`, [staffId, user!.id]);
  }
  await tx.execute(`DELETE FROM "UserRefreshToken" WHERE "userId" IN (SELECT "userId" FROM "Staff" WHERE "facilityId" = :fid AND id = $1)`, [staffId]);
  await recordAudit(tx, actor, "Login Set", `${staff.name} (${loginEmail})`);
}

/** Removes a staff member's access: the login is switched off (kept for the record) and every session it holds ends. */
export async function removeLogin(tx: Queryable, staffId: string, actor: string): Promise<void> {
  const staff = await tx.queryOne<{ name: string; userId: string | null }>(
    `SELECT name, "userId" FROM "Staff" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`,
    [staffId],
  );
  if (!staff) throw notFound("Staff member");
  if (staff.userId) {
    await tx.execute(
      `UPDATE "User" SET active = false, "mustChangePassword" = false, "resetRequestedAt" = NULL, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now()
        WHERE "facilityId" = :fid AND id = $1`,
      [staff.userId],
    );
    await tx.execute(`DELETE FROM "UserRefreshToken" WHERE "userId" = $1 AND EXISTS (SELECT 1 FROM "User" WHERE "facilityId" = :fid AND id = $1)`, [staff.userId]);
  }
  await recordAudit(tx, actor, "Login Removed", staff.name);
}

/** Ends every session of a staff member's login (used when they are deactivated or their role changes). */
export async function endSessions(tx: Queryable, staffId: string): Promise<void> {
  await tx.execute(
    `UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now()
      WHERE "facilityId" = :fid AND id = (SELECT "userId" FROM "Staff" WHERE "facilityId" = :fid AND id = $1)`,
    [staffId],
  );
}

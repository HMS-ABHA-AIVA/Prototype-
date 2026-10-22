import { createHmac } from "node:crypto";
import bcrypt from "bcrypt";
import { Router, type RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { rateLimit } from "../../../common/middlewares/rateLimit.middleware.js";
import { logSecurityEvent } from "../../../common/utils/securityLog.js";
import { BCRYPT_ROUNDS, LOCK_MINUTES, MAX_FAILED_LOGINS, passwordProblem } from "../../auth/accounts.js";
import type { HospitalContext } from "../../context.js";
import type { Database } from "../../db.js";
import { AppError, badRequest, conflict, notFound, unauthorized } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";

/**
 * The platform console: for the people who run the product, not for a hospital's staff. They sign in here (their own login and token,
 * which never opens a hospital), list the hospitals (Facility rows), set up a new one with its first administrator, rename one, switch
 * one off or on, and give a hospital's administrator a new login when they are locked out. None of this reads patients or records.
 * Hospitals can still register themselves (POST /api/facility/register); a suspended hospital's staff and owner cannot sign in.
 */
export interface PlatformAdminSession {
  id: string;
  name: string;
  username: string;
  mustChangePassword: boolean;
}

interface AdminRow extends PlatformAdminSession {
  passwordHash: string;
  active: boolean;
  failedLogins: number;
  lockedUntil: string | null;
  tokenVersion: number;
}

const COLUMNS = 'id, name, username, "mustChangePassword", "passwordHash", active, "failedLogins", "lockedUntil", "tokenVersion"';
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-1", 10);

/** The platform token's own key, derived from (never equal to) the staff token secret. */
const platformSecret = () => createHmac("sha256", process.env.USER_ACCESS_TOKEN_SECRET!).update("platform-token-v1").digest("hex");

export async function platformAudit(db: Database, actor: string, action: string, detail: string) {
  await db.platform.execute('INSERT INTO "PlatformAudit" (actor, action, detail) VALUES ($1, $2, $3)', [actor, action, detail]);
}

/** Creates the first platform administrator from PLATFORM_ADMIN_USERNAME / PLATFORM_ADMIN_PASSWORD, once. */
export async function bootstrapPlatformAdmin({ db, env, log }: Pick<HospitalContext, "db" | "env" | "log">): Promise<void> {
  const admin = env.platformAdmin;
  if (!admin) return;
  if (await db.platform.queryOne('SELECT 1 FROM "PlatformAdmin" WHERE lower(username) = $1', [admin.username])) return;
  const problem = passwordProblem(`${admin.username}@platform`, admin.password);
  if (problem) {
    log.warn(`PLATFORM_ADMIN_PASSWORD is too weak (${problem}); no platform administrator was created`);
    return;
  }
  await db.platform.execute('INSERT INTO "PlatformAdmin" (name, username, "passwordHash") VALUES ($1, $2, $3)', [
    "Platform Administrator",
    admin.username,
    await bcrypt.hash(admin.password, BCRYPT_ROUNDS),
  ]);
  await platformAudit(db, "system", "Platform Administrator Created", admin.username);
  log.info("platform administrator created from PLATFORM_ADMIN_USERNAME / PLATFORM_ADMIN_PASSWORD", { username: admin.username });
}

const FACILITY_COLUMNS = `f.id, f.name, f."hfrId", f."hfrId" AS code, f.email AS "ownerEmail", f.status, f."suspendedAt", f."createdAt",
  (SELECT count(*)::int FROM "User" u WHERE u."facilityId" = f.id AND u.active) AS logins,
  (SELECT count(*)::int FROM "Patient" p WHERE p."facilityId" = f.id) AS patients`;

const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const hospitalSchema = z.object({
  name: z.string().trim().min(3).max(100),
  hfrId: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, "HFR ID may contain only letters, numbers, - and _"),
  adminName: z.string().trim().min(3).max(50),
  adminEmail: email,
  adminPassword: z.string().min(1).max(128),
  /** The facility owner login (ABDM credentials, facility setup). Defaults to the administrator's e-mail. */
  ownerEmail: email.optional(),
});
const updateSchema = z.object({ name: z.string().trim().min(3).max(100).optional(), status: z.enum(["active", "suspended"]).optional() });
const adminLoginSchema = z.object({ email, password: z.string().min(1).max(128), name: z.string().trim().min(3).max(50).optional() });

export function platformRouter(ctx: HospitalContext): Router {
  const { env, db } = ctx;
  const router = Router();
  const p = db.platform;

  const loginLimit: RequestHandler = env.rateLimitEnabled
    ? rateLimit({ windowMs: 15 * 60_000, max: 20, key: (req) => `platform-login:${req.ip}`, message: "Too many sign-in attempts. Please wait a few minutes." })
    : (_req, _res, next) => next();

  const issue = (admin: { id: string }, tokenVersion: number) =>
    jwt.sign({ sub: admin.id, tv: tokenVersion, pa: true }, platformSecret(), { algorithm: "HS256", expiresIn: `${env.platformTokenHours}h` });
  const toSession = (row: AdminRow): PlatformAdminSession => ({ id: row.id, name: row.name, username: row.username, mustChangePassword: row.mustChangePassword });

  router.post("/login", loginLimit, async (req, res) => {
    const { username, password } = parse(z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(128) }), req.body);
    const row = await p.queryOne<AdminRow>(`SELECT ${COLUMNS} FROM "PlatformAdmin" WHERE lower(username) = lower($1)`, [username]);
    if (!row || !row.active) {
      await bcrypt.compare(password, DUMMY_HASH);
      logSecurityEvent("LOGIN_FAILURE", req, { actor: "platform" });
      throw unauthorized("Wrong username or password");
    }
    if (row.lockedUntil && new Date(row.lockedUntil) > new Date()) {
      throw new AppError(429, "ACCOUNT_LOCKED", `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`);
    }
    if (!(await bcrypt.compare(password, row.passwordHash))) {
      const failed = row.failedLogins + 1;
      const locks = failed >= MAX_FAILED_LOGINS;
      await p.execute(
        `UPDATE "PlatformAdmin" SET "failedLogins" = $2, "lockedUntil" = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE "lockedUntil" END WHERE id = $1`,
        [row.id, locks ? 0 : failed, locks, LOCK_MINUTES],
      );
      if (locks) await platformAudit(db, row.username, "Platform Account Locked", `${MAX_FAILED_LOGINS} wrong passwords`);
      logSecurityEvent("LOGIN_FAILURE", req, { actor: "platform" });
      throw unauthorized("Wrong username or password");
    }
    await p.execute('UPDATE "PlatformAdmin" SET "failedLogins" = 0, "lockedUntil" = NULL, "lastLoginAt" = now() WHERE id = $1', [row.id]);
    await platformAudit(db, row.username, "Platform Sign-in", "");
    logSecurityEvent("LOGIN_SUCCESS", req, { actor: "platform" });
    res.json({ token: issue(row, row.tokenVersion), admin: toSession(row) });
  });

  // Everything below needs a platform administrator's token (Authorization: Bearer ...). A staff cookie never opens this.
  router.use(async (req, _res, next) => {
    try {
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      let payload: { sub?: unknown; tv?: unknown; pa?: unknown } | null = null;
      try {
        payload = token ? (jwt.verify(token, platformSecret(), { algorithms: ["HS256"] }) as unknown as { sub?: unknown; tv?: unknown; pa?: unknown }) : null;
      } catch {
        payload = null;
      }
      const row =
        payload?.pa === true && typeof payload.sub === "string"
          ? await p.queryOne<AdminRow>(`SELECT ${COLUMNS} FROM "PlatformAdmin" WHERE id = $1`, [payload.sub])
          : null;
      if (!row || !row.active || row.tokenVersion !== payload?.tv) throw unauthorized(token ? "Your session has ended. Please sign in again." : "Please sign in to continue");
      (req as { platformAdmin?: PlatformAdminSession }).platformAdmin = toSession(row);
      next();
    } catch (error) {
      next(error);
    }
  });
  const adminOf = (req: unknown) => (req as { platformAdmin: PlatformAdminSession }).platformAdmin;

  router.get("/me", (req, res) => {
    res.json({ admin: adminOf(req) });
  });

  router.post("/change-password", async (req, res) => {
    const admin = adminOf(req);
    const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }), req.body);
    const row = await p.queryOne<AdminRow>(`SELECT ${COLUMNS} FROM "PlatformAdmin" WHERE id = $1`, [admin.id]);
    if (!row || !(await bcrypt.compare(currentPassword, row.passwordHash))) throw badRequest("The current password is not correct");
    const problem = passwordProblem(`${row.username}@platform`, newPassword);
    if (problem) throw badRequest(problem);
    if (newPassword === currentPassword) throw badRequest("Choose a password different from the current one");
    const version = row.tokenVersion + 1;
    await p.execute('UPDATE "PlatformAdmin" SET "passwordHash" = $2, "mustChangePassword" = false, "tokenVersion" = $3 WHERE id = $1', [
      admin.id,
      await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
      version,
    ]);
    await platformAudit(db, admin.username, "Platform Password Changed", "");
    res.json({ token: issue(row, version) });
  });

  router.get("/facilities", async (_req, res) => {
    res.json(await p.query(`SELECT ${FACILITY_COLUMNS} FROM "Facility" f ORDER BY f.name`));
  });

  // A new hospital with its owner login and first administrator (who must choose their own password at first sign-in).
  router.post("/facilities", async (req, res) => {
    const admin = adminOf(req);
    const input = parse(hospitalSchema, req.body);
    const problem = passwordProblem(input.adminEmail, input.adminPassword);
    if (problem) throw badRequest(problem);
    const ownerEmail = input.ownerEmail ?? input.adminEmail;
    const hash = await bcrypt.hash(input.adminPassword, BCRYPT_ROUNDS);
    const facility = await p.transaction(async (tx) => {
      if (await tx.queryOne('SELECT 1 FROM "Facility" WHERE "hfrId" = $1 OR lower(email) = $2', [input.hfrId, ownerEmail])) {
        throw conflict("A hospital with that HFR ID or owner e-mail already exists");
      }
      if (await tx.queryOne('SELECT 1 FROM "User" WHERE lower(email) = $1', [input.adminEmail])) throw conflict("That administrator e-mail is already used by another login");
      const created = (await tx.queryOne<{ id: string }>(
        `INSERT INTO "Facility" (id, name, "hfrId", email, "passwordHash", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now() AT TIME ZONE 'UTC') RETURNING id`,
        [input.name, input.hfrId, ownerEmail, hash],
      ))!;
      const user = (await tx.queryOne<{ id: string }>(
        `INSERT INTO "User" (id, "facilityId", name, email, "passwordHash", role, "mustChangePassword", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'admin', true, now()) RETURNING id`,
        [created.id, input.adminName, input.adminEmail, hash],
      ))!;
      await tx.execute(`INSERT INTO "Staff" ("facilityId", "userId", name, role, department) VALUES ($1, $2, $3, 'admin', 'Administration')`, [created.id, user.id, input.adminName]);
      await tx.execute('INSERT INTO "AuditLog" ("facilityId", actor, action, detail) VALUES ($1, $2, $3, $4)', [
        created.id, `platform: ${admin.username}`, "Hospital Set Up", input.adminEmail,
      ]);
      return tx.queryOne(`SELECT ${FACILITY_COLUMNS} FROM "Facility" f WHERE f.id = $1`, [created.id]);
    });
    await platformAudit(db, admin.username, "Hospital Set Up", `${input.name} (${input.hfrId})`);
    res.status(201).json(facility);
  });

  router.patch("/facilities/:id", async (req, res) => {
    const admin = adminOf(req);
    const { name, status } = parse(updateSchema, req.body);
    const id = String(req.params.id);
    const current = await p.queryOne<{ name: string; status: string }>('SELECT name, status FROM "Facility" WHERE id = $1', [id]);
    if (!current) throw notFound("Hospital");
    if (name && name !== current.name) {
      await p.execute(`UPDATE "Facility" SET name = $2, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`, [id, name]);
      await platformAudit(db, admin.username, "Hospital Renamed", `${current.name} -> ${name}`);
    }
    if (status && status !== current.status) {
      await p.execute(`UPDATE "Facility" SET status = $2, "suspendedAt" = CASE WHEN $2 = 'suspended' THEN now() ELSE NULL END, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`, [
        id, status,
      ]);
      await platformAudit(db, admin.username, status === "suspended" ? "Hospital Switched Off" : "Hospital Switched On", name ?? current.name);
    }
    res.json(await p.queryOne(`SELECT ${FACILITY_COLUMNS} FROM "Facility" f WHERE f.id = $1`, [id]));
  });

  // Support for a hospital whose administrator is locked out or has left: creates or resets an administrator login there.
  router.post("/facilities/:id/admin-login", async (req, res) => {
    const admin = adminOf(req);
    const { email: loginEmail, password, name } = parse(adminLoginSchema, req.body);
    const facilityId = String(req.params.id);
    const facility = await p.queryOne<{ name: string }>('SELECT name FROM "Facility" WHERE id = $1', [facilityId]);
    if (!facility) throw notFound("Hospital");
    const problem = passwordProblem(loginEmail, password);
    if (problem) throw badRequest(problem);
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await p.transaction(async (tx) => {
      const existing = await tx.queryOne<{ id: string; facilityId: string; role: string }>('SELECT id, "facilityId", role::text AS role FROM "User" WHERE lower(email) = $1', [loginEmail]);
      if (existing && (existing.facilityId !== facilityId || existing.role !== "admin")) {
        throw new AppError(409, "CONFLICT", "That e-mail belongs to a login that is not an administrator of this hospital");
      }
      let userId = existing?.id;
      if (userId) {
        await tx.execute(
          `UPDATE "User" SET "passwordHash" = $2, active = true, "mustChangePassword" = true, "failedLogins" = 0, "lockedUntil" = NULL,
                  "tokenVersion" = "tokenVersion" + 1, "resetRequestedAt" = NULL, "updatedAt" = now() WHERE id = $1`,
          [userId, hash],
        );
      } else {
        userId = (await tx.queryOne<{ id: string }>(
          `INSERT INTO "User" (id, "facilityId", name, email, "passwordHash", role, "mustChangePassword", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'admin', true, now()) RETURNING id`,
          [facilityId, name ?? "Administrator", loginEmail, hash],
        ))!.id;
      }
      await tx.execute(
        `INSERT INTO "Staff" ("facilityId", "userId", name, role, department) VALUES ($1, $2, $3, 'admin', 'Administration')
         ON CONFLICT ("userId") DO UPDATE SET active = true, role = 'admin'`,
        [facilityId, userId, name ?? "Administrator"],
      );
      await tx.execute('INSERT INTO "AuditLog" ("facilityId", actor, action, detail) VALUES ($1, $2, $3, $4)', [
        facilityId, `platform: ${admin.username}`, "Administrator Login Set", loginEmail,
      ]);
    });
    await platformAudit(db, admin.username, "Hospital Administrator Login Set", `${facility.name} (${loginEmail})`);
    res.json({ ok: true });
  });

  router.get("/audit", async (_req, res) => {
    res.json(await p.query('SELECT id, at, actor, action, detail FROM "PlatformAudit" ORDER BY id DESC LIMIT 200'));
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { loginSchema, removeLogin, setLogin } from "../../auth/accounts.js";
import { requireRole, STAFF_ROLES } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Hospital staff (the Staff table). hprId is the Health Professional Registry id ABDM needs for every doctor and nurse whose
 * records will be shared. A staff member may have a login (a User, linked by Staff.userId); the role on the Staff record is
 * the one that counts, and the login's copy is kept in step. Thin module: routes use SQL directly.
 */
export interface StaffRow {
  id: string;
  name: string;
  role: string;
  department: string;
  hprId: string | null;
  employmentType: "salaried" | "visiting_fee";
  monthlySalary: number | null;
  feePerConsult: number | null;
  /** What a patient pays to see this doctor, if set for this doctor. */
  consultationFee: number | null;
  /** What a patient pays to see this doctor: their own fee, or the hospital's standard OPD consultation fee. */
  opdFee: number;
  bankAccountLast4: string | null;
  dateOfJoining: string;
  active: boolean;
  /** Sign-in e-mail, or null when this person has no login. Visible to administrators only. */
  username: string | null;
  email: string | null;
  hasLogin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  /** When this person asked for a password reset and it has not been done yet. */
  resetRequestedAt: string | null;
}

const COLUMNS = `/* fragment: every caller adds s."facilityId" = :fid */ s.id, s.name, s.role::text AS role, s.department, s."hprId", s."employmentType"::text AS "employmentType", s."monthlySalary",
  s."feePerConsult", s."consultationFee",
  COALESCE(s."consultationFee", (SELECT value::numeric FROM "HospitalSetting" hs WHERE hs."facilityId" = s."facilityId" AND hs.key = 'opd_default_fee'), 600)::float8 AS "opdFee",
  s."bankAccountLast4", s."dateOfJoining", s.active,
  CASE WHEN u.active THEN u.email END AS username, CASE WHEN u.active THEN u.email END AS email, COALESCE(u.active, false) AS "hasLogin",
  COALESCE(u.active AND u."mustChangePassword", false) AS "mustChangePassword", u."lastLoginAt",
  CASE WHEN u.active THEN u."resetRequestedAt" END AS "resetRequestedAt"`;
const FROM = `"Staff" s LEFT JOIN "User" u ON u.id = s."userId"`;

const hprId = z.string().trim().regex(/^[A-Za-z0-9@._-]{3,64}$/, "HPR id looks invalid").nullable();

const createStaffSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(STAFF_ROLES),
  department: z.string().trim().min(1).max(80),
  hprId: hprId.optional(),
  employmentType: z.enum(["salaried", "visiting_fee"]).default("salaried"),
  monthlySalary: z.number().min(0).nullable().optional(),
  feePerConsult: z.number().min(0).nullable().optional(),
  consultationFee: z.number().min(0).max(100000).nullable().optional(),
  /** Last four digits only: full bank details are never stored. */
  bankAccountLast4: z.string().regex(/^\d{4}$/, "Enter exactly the last 4 digits").nullable().optional(),
});
const updateStaffSchema = createStaffSchema.partial().extend({ active: z.boolean().optional() });

/** Pay and login details are for administrators; everyone else sees only what is needed to pick a colleague. */
function visibleTo(row: StaffRow, viewerRole: string): StaffRow {
  if (viewerRole === "admin") return row;
  return {
    ...row,
    monthlySalary: null,
    bankAccountLast4: null,
    username: null,
    email: null,
    hasLogin: false,
    mustChangePassword: false,
    lastLoginAt: null,
    resetRequestedAt: null,
  };
}

export const listDoctors = (db: Queryable) =>
  db.query<StaffRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s."facilityId" = :fid AND s.role = 'doctor' AND s.active ORDER BY s.name`);
export const findStaff = (db: Queryable, id: string) => db.queryOne<StaffRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s."facilityId" = :fid AND s.id = $1`, [id]);

export function staffRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const role = typeof req.query.role === "string" ? req.query.role : null;
    const rows = await db.query<StaffRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s."facilityId" = :fid AND ($1::text IS NULL OR s.role::text = $1) ORDER BY s.name`, [role]);
    res.json(rows.map((row) => visibleTo(row, staffOf(req).role)));
  });

  router.get("/:id", async (req, res) => {
    const row = await findStaff(db, uuidParam(req));
    if (!row) throw notFound("Staff member");
    res.json(visibleTo(row, staffOf(req).role));
  });

  router.post("/", requireRole("admin"), async (req, res) => {
    const s = parse(createStaffSchema, req.body);
    const row = await db.transaction(async (tx) => {
      const created = await tx.queryOne<{ id: string }>(
        `INSERT INTO "Staff" ("facilityId", name, role, department, "hprId", "employmentType", "monthlySalary", "feePerConsult", "consultationFee", "bankAccountLast4")
         VALUES (:fid, $1, $2::"StaffRole", $3, $4, $5::"EmploymentType", $6, $7, $8, $9) RETURNING id`,
        [s.name, s.role, s.department, s.hprId ?? null, s.employmentType, s.monthlySalary ?? null, s.feePerConsult ?? null, s.consultationFee ?? null, s.bankAccountLast4 ?? null],
      );
      await recordAudit(tx, actorOf(req), "Staff Added", `${s.name} (${s.role})`);
      return findStaff(tx, created!.id);
    });
    res.status(201).json(row);
  });

  router.patch("/:id", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const s = parse(updateStaffSchema, req.body);
    if (id === staffOf(req).id && (s.active === false || (s.role && s.role !== "admin"))) {
      throw badRequest("You cannot deactivate yourself or take away your own administrator role");
    }
    const row = await db.transaction(async (tx) => {
      const current = await tx.queryOne<StaffRow & { userId: string | null }>(
        `SELECT ${COLUMNS}, s."userId" FROM ${FROM} WHERE s."facilityId" = :fid AND s.id = $1 FOR UPDATE OF s`,
        [id],
      );
      if (!current) throw notFound("Staff member");
      const n = { ...current, ...s };
      await tx.execute(
        `UPDATE "Staff" SET name=$2, role=$3::"StaffRole", department=$4, "hprId"=$5, "employmentType"=$6::"EmploymentType", "monthlySalary"=$7,
                "feePerConsult"=$8, "consultationFee"=$9, "bankAccountLast4"=$10, active=$11, "updatedAt" = now()
          WHERE "facilityId" = :fid AND id = $1`,
        [id, n.name, n.role, n.department, n.hprId, n.employmentType, n.monthlySalary, n.feePerConsult, n.consultationFee, n.bankAccountLast4, n.active],
      );
      // The login carries a copy of the name and role (the sign-in screen shows them); keep it in step.
      // Deactivating someone also signs them out everywhere and drops any pending password-reset request.
      if (current.userId) {
        const deactivated = current.active && n.active === false;
        await tx.execute(
          `UPDATE "User" SET name = $2, role = $3::"StaffRole", "updatedAt" = now(),
                  "tokenVersion" = "tokenVersion" + CASE WHEN $4 THEN 1 ELSE 0 END,
                  "resetRequestedAt" = CASE WHEN $4 THEN NULL ELSE "resetRequestedAt" END
            WHERE "facilityId" = :fid AND id = $1`,
          [current.userId, n.name, n.role, deactivated],
        );
      }
      await recordAudit(tx, actorOf(req), "Staff Updated", n.name ?? current.name);
      return findStaff(tx, id);
    });
    res.json(row);
  });

  // ---- Sign-in access (administrators only) -------------------------------------------------
  // Give someone a login, or reset a forgotten password: they must choose their own at the next sign-in.
  router.put("/:id/login", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const { email, password } = parse(loginSchema, req.body);
    await db.transaction((tx) => setLogin(tx, id, email, password, actorOf(req)));
    res.json(await findStaff(db, id));
  });

  router.delete("/:id/login", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    if (id === staffOf(req).id) throw badRequest("You cannot remove your own login");
    await db.transaction((tx) => removeLogin(tx, id, actorOf(req)));
    res.json(await findStaff(db, id));
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { AppError } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse } from "../../shared/validate.js";

/**
 * The hospital's own profile (its Facility row). The HFR id is set when the facility registers and is also the HIP id that
 * ABDM routes Scan & Share callbacks to (integration/Abha/share), so it is shown here but not changed here.
 */
export interface FacilityRow {
  name: string;
  hfrId: string | null;
  hipId: string | null;
  facilityType: string | null;
  address: string | null;
  state: string | null;
  district: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}

const COLUMNS = `name, "hfrId", COALESCE("hipId", "hfrId") AS "hipId", "facilityType", address, state, district, pincode, phone,
  "contactEmail" AS email, latitude, longitude, "updatedAt"`;

export const getFacility = (db: Queryable) => db.queryOne<FacilityRow>(`SELECT ${COLUMNS} FROM "Facility" WHERE id = :fid`);

const optionalText = z.string().trim().max(200).nullable().optional();
const updateFacilitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "The hospital name must be at least 3 characters")
    .max(100)
    .regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\-]*$/u, "The hospital name contains characters that are not allowed")
    .optional(),
  hfrId: z.string().trim().nullable().optional(),
  hipId: z.string().trim().nullable().optional(),
  facilityType: optionalText,
  address: optionalText,
  state: optionalText,
  district: optionalText,
  pincode: z.string().trim().regex(/^\d{6}$/, "pincode is 6 digits").nullable().optional(),
  phone: optionalText,
  email: z.email().trim().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

export function facilityRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json(await getFacility(db));
  });

  // Only the fields that are sent are changed; send null to clear one.
  router.put("/", requireRole("admin"), async (req, res) => {
    const input = parse(updateFacilitySchema, req.body);
    const result = await db.transaction(async (tx) => {
      const current = (await tx.queryOne<FacilityRow>(`SELECT ${COLUMNS} FROM "Facility" WHERE id = :fid FOR UPDATE`))!;
      for (const field of ["hfrId", "hipId"] as const) {
        if (input[field] !== undefined && input[field] !== current[field]) {
          throw new AppError(
            400,
            "HFR_ID_FIXED",
            "The HFR id is set when the facility registers and is the HIP id ABDM sends Scan & Share to, so it cannot be changed here.",
          );
        }
      }
      const next = { ...current, ...input };
      await tx.execute(
        `UPDATE "Facility" SET name=$1, "facilityType"=$2, address=$3, state=$4, district=$5, pincode=$6, phone=$7, "contactEmail"=$8,
                latitude=$9, longitude=$10, "updatedAt" = now() AT TIME ZONE 'UTC'
          WHERE id = :fid`,
        [next.name, next.facilityType, next.address, next.state, next.district, next.pincode, next.phone, next.email, next.latitude, next.longitude],
      );
      await recordAudit(tx, actorOf(req), "Facility Profile Updated", next.hfrId ? `HFR ${next.hfrId}` : "");
      return getFacility(tx);
    });
    res.json(result);
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Services: everything that can be charged against an admission that is not a test or a medicine (nursing, procedures, doctor visits,
 * packages ...), each with a price and GST. A ward's daily bed charge is a service in the category 'bed' that names its ward.
 */
export const SERVICE_CATEGORIES = ["bed", "nursing", "procedure", "doctor_visit", "consultation", "package", "other"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ServiceRow {
  id: string;
  code: string;
  name: string;
  category: ServiceCategory;
  ward: string | null;
  price: number;
  gstPct: number;
  active: boolean;
}

const COLUMNS = 'id, code, name, category, ward, price::float8 AS price, "gstPct"::float8 AS "gstPct", active';

export const findService = (db: Queryable, id: string) => db.queryOne<ServiceRow>(`SELECT ${COLUMNS} FROM "Service" WHERE "facilityId" = :fid AND id = $1`, [id]);

/** The daily bed charge for a ward, if the hospital has set one. */
export const findBedService = (db: Queryable, ward: string) =>
  db.queryOne<ServiceRow>(`SELECT ${COLUMNS} FROM "Service" WHERE "facilityId" = :fid AND category = 'bed' AND ward = $1 AND active`, [ward]);

const fields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,29}$/, "Use 2-30 letters, digits, dots, dashes or underscores"),
  name: z.string().trim().min(2).max(160),
  category: z.enum(SERVICE_CATEGORIES),
  price: z.number().min(0).max(10_000_000),
  gstPct: z.number().min(0).max(100),
  active: z.boolean(),
};
const createSchema = z.object({ ...fields, gstPct: fields.gstPct.default(0), active: fields.active.default(true) });
const updateSchema = z.object(fields).partial();
const wardRateSchema = z.object({ ward: z.string().trim().min(1).max(80), price: fields.price, gstPct: fields.gstPct.default(0) });

/** Sets (or changes) a ward's daily bed charge. */
export async function setWardRate(tx: Queryable, ward: string, price: number, gstPct: number) {
  const code = `BED-${ward.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)}`;
  return tx.queryOne<ServiceRow>(
    `INSERT INTO "Service" ("facilityId", code, name, category, ward, price, "gstPct") VALUES (:fid, $1, $2, 'bed', $3, $4, $5)
     ON CONFLICT ("facilityId", ward) WHERE category = 'bed' DO UPDATE SET price = EXCLUDED.price, "gstPct" = EXCLUDED."gstPct", active = true, "updatedAt" = now()
     RETURNING ${COLUMNS}`,
    [code, `Bed charge per day: ${ward}`, ward, price, gstPct],
  );
}

export function servicesRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/services", async (req, res) => {
    const { category, search, all } = parse(
      z.object({ category: z.enum(SERVICE_CATEGORIES).optional(), search: z.string().trim().max(80).optional(), all: z.enum(["true", "false"]).default("false") }),
      req.query,
    );
    const everything = all === "true" && staffOf(req).role === "admin";
    res.json(
      await db.query<ServiceRow>(
        `SELECT ${COLUMNS} FROM "Service"
          WHERE "facilityId" = :fid AND ($1::text IS NULL OR category = $1) AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR code ILIKE $2 || '%')
            AND ($3::boolean OR active)
          ORDER BY category, name LIMIT 500`,
        [category ?? null, search || null, everything],
      ),
    );
  });

  router.post("/services", requireRole("admin"), async (req, res) => {
    const s = parse(createSchema, req.body);
    if (s.category === "bed") throw conflict("Set a ward's bed charge on the Wards tab");
    const row = await db.transaction(async (tx) => {
      const created = await tx.queryOne<ServiceRow>(
        `INSERT INTO "Service" ("facilityId", code, name, category, price, "gstPct", active) VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
        [s.code, s.name, s.category, s.price, s.gstPct, s.active],
      );
      await recordAudit(tx, actorOf(req), "Service Added", `${s.code} - ${s.name} (Rs ${s.price})`);
      return created;
    });
    res.status(201).json(row);
  });

  router.patch("/services/:id", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const change = parse(updateSchema, req.body);
    const row = await db.transaction(async (tx) => {
      const current = await findService(tx, id);
      if (!current) throw notFound("Service");
      if (current.category === "bed" && change.category && change.category !== "bed") throw conflict("A ward bed charge stays a bed charge");
      const n = { ...current, ...change };
      const updated = await tx.queryOne<ServiceRow>(
        `UPDATE "Service" SET code=$2, name=$3, category=$4, price=$5, "gstPct"=$6, active=$7, "updatedAt"=now() WHERE "facilityId" = :fid AND id=$1 RETURNING ${COLUMNS}`,
        [id, n.code, n.name, n.category, n.price, n.gstPct, n.active],
      );
      await recordAudit(tx, actorOf(req), "Service Updated", `${n.code}${change.price !== undefined ? ` price Rs ${current.price} -> Rs ${n.price}` : ""}`);
      return updated;
    });
    res.json(row);
  });

  // ---- Ward bed charges: one daily rate per ward -------------------------------------------------------------------------
  router.get("/wards", async (_req, res) => {
    res.json(
      await db.query(
        `SELECT w.ward, w.beds, s.id AS "serviceId", s.price::float8 AS daily_rate, COALESCE(s."gstPct", 0)::float8 AS "gstPct", s.active
           FROM (SELECT ward, count(*)::int AS beds FROM "Bed" WHERE "facilityId" = :fid GROUP BY ward
                 UNION ALL SELECT ward, 0 FROM "Service"
                  WHERE "facilityId" = :fid AND category = 'bed' AND ward NOT IN (SELECT ward FROM "Bed" WHERE "facilityId" = :fid)) w
           LEFT JOIN "Service" s ON s."facilityId" = :fid AND s.category = 'bed' AND s.ward = w.ward
          ORDER BY w.ward`,
      ),
    );
  });

  router.put("/wards", requireRole("admin"), async (req, res) => {
    const { ward, price, gstPct } = parse(wardRateSchema, req.body);
    const row = await db.transaction(async (tx) => {
      const saved = await setWardRate(tx, ward, price, gstPct);
      await recordAudit(tx, actorOf(req), "Ward Bed Charge Set", `${ward}: Rs ${price} per day`);
      return saved;
    });
    res.json(row);
  });

  return router;
}

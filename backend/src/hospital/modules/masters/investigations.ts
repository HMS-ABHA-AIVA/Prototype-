import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Investigations: the lab and radiology tests the hospital offers, each with a price, GST, sample type and turnaround time. A lab test
 * lists what it measures and the normal range for each, which result entry and the printed report use.
 */
export interface ParameterRow {
  id: string;
  name: string;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  sortOrder: number;
}
export interface InvestigationRow {
  id: string;
  code: string;
  name: string;
  kind: "lab" | "radiology";
  section: string | null;
  sample: string | null;
  tatHours: number | null;
  price: number;
  gstPct: number;
  active: boolean;
}
export interface InvestigationDetail extends InvestigationRow {
  parameters: ParameterRow[];
}

const COLUMNS = 'id, code, name, kind, section, sample, "tatHours", price::float8 AS price, "gstPct"::float8 AS "gstPct", active';
const PARAMETER_COLUMNS =
  'id, name, unit, "refLow"::float8 AS "refLow", "refHigh"::float8 AS "refHigh", "refText", "criticalLow"::float8 AS "criticalLow", "criticalHigh"::float8 AS "criticalHigh", "sortOrder"';

export const findInvestigation = (db: Queryable, id: string) =>
  db.queryOne<InvestigationRow>(`SELECT ${COLUMNS} FROM "Investigation" WHERE "facilityId" = :fid AND id = $1`, [id]);

/** The test an order means, matched by name when the order was typed rather than picked. */
export const findInvestigationByName = (db: Queryable, name: string) =>
  db.queryOne<InvestigationRow>(`SELECT ${COLUMNS} FROM "Investigation" WHERE "facilityId" = :fid AND lower(name) = lower($1) AND active`, [name.trim()]);

export async function investigationDetail(db: Queryable, id: string): Promise<InvestigationDetail | null> {
  const row = await findInvestigation(db, id);
  if (!row) return null;
  const parameters = await db.query<ParameterRow>(
    `SELECT ${PARAMETER_COLUMNS} FROM "InvestigationParameter" WHERE "facilityId" = :fid AND "investigationId" = $1 ORDER BY "sortOrder", name`,
    [id],
  );
  return { ...row, parameters };
}

const parameterSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    unit: z.string().trim().max(30).nullable().default(null),
    refLow: z.number().nullable().default(null),
    refHigh: z.number().nullable().default(null),
    refText: z.string().trim().max(120).nullable().default(null),
    criticalLow: z.number().nullable().default(null),
    criticalHigh: z.number().nullable().default(null),
  })
  .refine((p) => p.refLow === null || p.refHigh === null || p.refLow <= p.refHigh, "The low end of the range cannot be above the high end")
  .refine((p) => p.criticalLow === null || p.refLow === null || p.criticalLow <= p.refLow, "The critical low limit must not be above the normal low")
  .refine((p) => p.criticalHigh === null || p.refHigh === null || p.criticalHigh >= p.refHigh, "The critical high limit must not be below the normal high");

const fields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,29}$/, "Use 2-30 letters, digits, dots, dashes or underscores"),
  name: z.string().trim().min(2).max(160),
  kind: z.enum(["lab", "radiology"]),
  section: z.string().trim().max(60).nullable(),
  sample: z.string().trim().max(60).nullable(),
  tatHours: z.number().int().min(0).max(720).nullable(),
  price: z.number().min(0).max(10_000_000),
  gstPct: z.number().min(0).max(100),
  active: z.boolean(),
  parameters: z.array(parameterSchema).max(60),
};
const createSchema = z.object({
  ...fields,
  section: fields.section.default(null),
  sample: fields.sample.default(null),
  tatHours: fields.tatHours.default(null),
  gstPct: fields.gstPct.default(0),
  active: fields.active.default(true),
  parameters: fields.parameters.default([]),
});
const updateSchema = z.object(fields).partial();

export async function writeParameters(tx: Queryable, id: string, parameters: z.output<typeof parameterSchema>[]) {
  await tx.execute('DELETE FROM "InvestigationParameter" WHERE "facilityId" = :fid AND "investigationId" = $1', [id]);
  let order = 0;
  for (const p of parameters) {
    await tx.execute(
      `INSERT INTO "InvestigationParameter" ("facilityId", "investigationId", name, unit, "refLow", "refHigh", "refText", "criticalLow", "criticalHigh", "sortOrder")
       VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, p.name, p.unit, p.refLow, p.refHigh, p.refText, p.criticalLow, p.criticalHigh, order++],
    );
  }
}

export function investigationsRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/investigations", async (req, res) => {
    const { kind, search, all } = parse(
      z.object({ kind: z.enum(["lab", "radiology"]).optional(), search: z.string().trim().max(80).optional(), all: z.enum(["true", "false"]).default("false") }),
      req.query,
    );
    const everything = all === "true" && staffOf(req).role === "admin";
    res.json(
      await db.query<InvestigationRow>(
        `SELECT ${COLUMNS} FROM "Investigation"
          WHERE "facilityId" = :fid AND ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR code ILIKE $2 || '%')
            AND ($3::boolean OR active)
          ORDER BY kind, name LIMIT 500`,
        [kind ?? null, search || null, everything],
      ),
    );
  });

  router.get("/investigations/:id", async (req, res) => {
    const detail = await investigationDetail(db, uuidParam(req));
    if (!detail) throw notFound("Investigation");
    res.json(detail);
  });

  router.post("/investigations", requireRole("admin"), async (req, res) => {
    const t = parse(createSchema, req.body);
    if (t.kind === "radiology" && t.parameters.length) throw badRequest("Only a lab test has parameters with normal ranges");
    const id = await db.transaction(async (tx) => {
      const row = await tx.queryOne<{ id: string }>(
        `INSERT INTO "Investigation" ("facilityId", code, name, kind, section, sample, "tatHours", price, "gstPct", active)
         VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [t.code, t.name, t.kind, t.section, t.sample, t.tatHours, t.price, t.gstPct, t.active],
      );
      await writeParameters(tx, row!.id, t.parameters);
      await recordAudit(tx, actorOf(req), "Investigation Added", `${t.code} - ${t.name} (Rs ${t.price})`);
      return row!.id;
    });
    res.status(201).json(await investigationDetail(db, id));
  });

  router.patch("/investigations/:id", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const change = parse(updateSchema, req.body);
    await db.transaction(async (tx) => {
      const current = await findInvestigation(tx, id);
      if (!current) throw notFound("Investigation");
      const n = { ...current, ...change };
      if (n.kind === "radiology" && change.parameters?.length) throw badRequest("Only a lab test has parameters with normal ranges");
      await tx.execute(
        `UPDATE "Investigation" SET code=$2, name=$3, kind=$4, section=$5, sample=$6, "tatHours"=$7, price=$8, "gstPct"=$9, active=$10, "updatedAt"=now()
          WHERE "facilityId" = :fid AND id=$1`,
        [id, n.code, n.name, n.kind, n.section, n.sample, n.tatHours, n.price, n.gstPct, n.active],
      );
      if (change.parameters) await writeParameters(tx, id, change.parameters);
      await recordAudit(tx, actorOf(req), "Investigation Updated", `${n.code}${change.price !== undefined ? ` price Rs ${current.price} -> Rs ${n.price}` : ""}`);
    });
    res.json(await investigationDetail(db, id));
  });

  return router;
}

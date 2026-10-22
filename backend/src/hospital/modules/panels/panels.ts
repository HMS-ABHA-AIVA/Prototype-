import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import type { PanelPricing } from "../opd-billing/opd-pricing.js";

/**
 * Panels: organisations whose beneficiaries are charged special rates (CGHS, DGHS, ECHS, insurers, corporates). Administrators set them up
 * and enter the rates the hospital has agreed; billing staff choose one at OPD billing. No rates are built in.
 * A panel's fee for a consultation is its rate for that department, else its flat fee, else the standard fee less its discount.
 */
export interface PanelRow {
  id: string;
  code: string;
  name: string;
  category: "government" | "insurance" | "corporate" | "other";
  discountPct: number;
  flatFee: number | null;
  requiresBeneficiaryId: boolean;
  active: boolean;
  rates: { department: string; fee: number }[];
  /** False when nothing is set (no rate, flat fee or discount): billing then charges the standard fee, which is probably not intended. */
  hasSpecialRates: boolean;
}

const COLUMNS = 'id, code, name, category, "discountPct"::float8 AS "discountPct", "flatFee"::float8 AS "flatFee", "requiresBeneficiaryId", active';

async function withRates(db: Queryable, rows: Omit<PanelRow, "rates" | "hasSpecialRates">[]): Promise<PanelRow[]> {
  if (rows.length === 0) return [];
  const rates = await db.query<{ panelId: string; department: string; fee: number }>(
    'SELECT "panelId", department, fee::float8 AS fee FROM "PanelRate" WHERE "facilityId" = :fid AND "panelId" = ANY($1::text[]) ORDER BY department',
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => {
    const own = rates.filter((x) => x.panelId === r.id).map(({ department, fee }) => ({ department, fee }));
    return { ...r, rates: own, hasSpecialRates: own.length > 0 || r.flatFee !== null || r.discountPct > 0 };
  });
}

export async function listPanels(db: Queryable, activeOnly: boolean): Promise<PanelRow[]> {
  const rows = await db.query<Omit<PanelRow, "rates" | "hasSpecialRates">>(
    `SELECT ${COLUMNS} FROM "Panel" WHERE "facilityId" = :fid AND ($1::boolean = false OR active) ORDER BY name`,
    [activeOnly],
  );
  return withRates(db, rows);
}

export async function findPanel(db: Queryable, id: string): Promise<PanelRow | null> {
  const row = await db.queryOne<Omit<PanelRow, "rates" | "hasSpecialRates">>(`SELECT ${COLUMNS} FROM "Panel" WHERE "facilityId" = :fid AND id = $1`, [id]);
  return row ? (await withRates(db, [row]))[0]! : null;
}

/** What the pricing rules need to know about a panel. */
export const toPricing = (panel: PanelRow): PanelPricing => ({
  id: panel.id,
  code: panel.code,
  name: panel.name,
  discountPct: panel.discountPct,
  flatFee: panel.flatFee,
  rates: Object.fromEntries(panel.rates.map((r) => [r.department.trim().toLowerCase(), r.fee])),
});

const panelFields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 _-]{1,19}$/, "Use 2-20 letters, digits, spaces, dashes or underscores"),
  name: z.string().trim().min(1).max(120),
  category: z.enum(["government", "insurance", "corporate", "other"]),
  discountPct: z.number().min(0).max(100),
  flatFee: z.number().min(0).max(1_000_000).nullable(),
  requiresBeneficiaryId: z.boolean(),
  active: z.boolean(),
};
const createSchema = z.object({
  ...panelFields,
  category: panelFields.category.default("other"),
  discountPct: panelFields.discountPct.default(0),
  flatFee: panelFields.flatFee.default(null),
  requiresBeneficiaryId: panelFields.requiresBeneficiaryId.default(true),
  active: panelFields.active.default(true),
});
const updateSchema = z.object(panelFields).partial();
const ratesSchema = z.object({
  rates: z.array(z.object({ department: z.string().trim().min(1).max(80), fee: z.number().min(0).max(1_000_000) })).max(60),
});

export function panelsRouter({ db }: HospitalContext): Router {
  const router = Router();

  // Staff who bill or admit see the active panels (the admitting doctor or nurse picks the billing category); administrators can ask for all of them.
  router.get("/", requireRole("front_office", "biller", "admin", "doctor", "nurse", "lab"), async (req, res) => {
    const { all } = parse(z.object({ all: z.enum(["true", "false"]).default("false") }), req.query);
    res.json(await listPanels(db, !(all === "true" && staffOf(req).role === "admin")));
  });

  router.post("/", requireRole("admin"), async (req, res) => {
    const p = parse(createSchema, req.body);
    const id = await db.transaction(async (tx) => {
      const row = await tx.queryOne<{ id: string }>(
        `INSERT INTO "Panel" ("facilityId", code, name, category, "discountPct", "flatFee", "requiresBeneficiaryId", active) VALUES (:fid, $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [p.code, p.name, p.category, p.discountPct, p.flatFee, p.requiresBeneficiaryId, p.active],
      );
      await recordAudit(tx, actorOf(req), "Panel Added", `${p.code} - ${p.name}`);
      return row!.id;
    });
    res.status(201).json(await findPanel(db, id));
  });

  router.patch("/:id", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const change = parse(updateSchema, req.body);
    await db.transaction(async (tx) => {
      const current = await findPanel(tx, id);
      if (!current) throw notFound("Panel");
      const n = { ...current, ...change };
      await tx.execute(
        `UPDATE "Panel" SET code=$2, name=$3, category=$4, "discountPct"=$5, "flatFee"=$6, "requiresBeneficiaryId"=$7, active=$8 WHERE "facilityId" = :fid AND id=$1`,
        [id, n.code, n.name, n.category, n.discountPct, n.flatFee, n.requiresBeneficiaryId, n.active],
      );
      await recordAudit(tx, actorOf(req), "Panel Updated", `${n.code}${change.active === false ? " (switched off)" : ""}`);
    });
    res.json(await findPanel(db, id));
  });

  // Replaces the panel's department rates with the list given.
  router.put("/:id/rates", requireRole("admin"), async (req, res) => {
    const id = uuidParam(req);
    const { rates } = parse(ratesSchema, req.body);
    await db.transaction(async (tx) => {
      const panel = await findPanel(tx, id);
      if (!panel) throw notFound("Panel");
      await tx.execute('DELETE FROM "PanelRate" WHERE "facilityId" = :fid AND "panelId" = $1', [id]);
      for (const r of rates) {
        await tx.execute(
          `INSERT INTO "PanelRate" ("facilityId", "panelId", department, fee) VALUES (:fid, $1,$2,$3)
           ON CONFLICT ("panelId", department) DO UPDATE SET fee = EXCLUDED.fee`,
          [id, r.department, r.fee],
        );
      }
      await recordAudit(tx, actorOf(req), "Panel Rates Updated", `${panel.code}: ${rates.length} rate(s)`);
    });
    res.json(await findPanel(db, id));
  });

  return router;
}

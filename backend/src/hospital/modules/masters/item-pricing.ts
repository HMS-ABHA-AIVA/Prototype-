import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * What a panel (CGHS, DGHS ...) pays for a service or an investigation: its own rate for that item, else the standard price less the
 * panel's discount %, else the standard price. (Consultation fees have their own rates; see modules/panels.)
 */
export type ItemKind = "service" | "investigation";

export interface ItemPricing {
  panel: { id: string; code: string; name: string; discountPct: number } | null;
  rates: Map<string, number>;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
const keyOf = (kind: ItemKind, id: string) => `${kind}:${id}`;

export async function loadItemPricing(db: Queryable, panelId: string | null): Promise<ItemPricing> {
  if (!panelId) return { panel: null, rates: new Map() };
  const panel = await db.queryOne<{ id: string; code: string; name: string; discountPct: number }>(
    'SELECT id, code, name, "discountPct"::float8 AS "discountPct" FROM "Panel" WHERE "facilityId" = :fid AND id = $1',
    [panelId],
  );
  if (!panel) return { panel: null, rates: new Map() };
  const rates = await db.query<{ itemKind: ItemKind; itemId: string; rate: number }>(
    'SELECT "itemKind", "itemId", rate::float8 AS rate FROM "PanelItemRate" WHERE "facilityId" = :fid AND "panelId" = $1',
    [panelId],
  );
  return { panel, rates: new Map(rates.map((r) => [keyOf(r.itemKind, r.itemId), r.rate])) };
}

/** The rate to charge for one item, with the standard price it came from. */
export function itemRate(pricing: ItemPricing, kind: ItemKind, item: { id: string; price: number }): { rate: number; standard: number; special: boolean } {
  const explicit = pricing.rates.get(keyOf(kind, item.id));
  if (explicit !== undefined) return { rate: explicit, standard: item.price, special: true };
  if (pricing.panel && pricing.panel.discountPct > 0) return { rate: round2(item.price * (1 - pricing.panel.discountPct / 100)), standard: item.price, special: true };
  return { rate: item.price, standard: item.price, special: false };
}

const ratesSchema = z.object({
  rates: z.array(z.object({ kind: z.enum(["service", "investigation"]), itemId: z.uuid(), rate: z.number().min(0).max(10_000_000) })).max(2000),
});

export function itemPricingRouter({ db }: HospitalContext): Router {
  const router = Router();

  // Every service and investigation with this panel's rate beside it (empty when the panel has none).
  router.get("/panels/:panelId/item-rates", requireRole("biller", "admin"), async (req, res) => {
    const panelId = uuidParam(req, "panelId");
    if (!(await db.queryOne('SELECT 1 FROM "Panel" WHERE "facilityId" = :fid AND id = $1', [panelId]))) throw notFound("Panel");
    const rates = await db.query<{ itemKind: ItemKind; itemId: string; rate: number }>(
      'SELECT "itemKind", "itemId", rate::float8 AS rate FROM "PanelItemRate" WHERE "facilityId" = :fid AND "panelId" = $1',
      [panelId],
    );
    const byKey = new Map(rates.map((r) => [keyOf(r.itemKind, r.itemId), r.rate]));
    const services = await db.query<{ id: string; code: string; name: string; category: string; price: number }>(
      `SELECT id, code, name, category, price::float8 AS price FROM "Service" WHERE "facilityId" = :fid AND active ORDER BY category, name`,
    );
    const investigations = await db.query<{ id: string; code: string; name: string; kind: string; price: number }>(
      `SELECT id, code, name, kind, price::float8 AS price FROM "Investigation" WHERE "facilityId" = :fid AND active ORDER BY kind, name`,
    );
    res.json({
      services: services.map((s) => ({ ...s, rate: byKey.get(keyOf("service", s.id)) ?? null })),
      investigations: investigations.map((i) => ({ ...i, rate: byKey.get(keyOf("investigation", i.id)) ?? null })),
    });
  });

  // Replaces the panel's item rates with the list given.
  router.put("/panels/:panelId/item-rates", requireRole("admin"), async (req, res) => {
    const panelId = uuidParam(req, "panelId");
    const { rates } = parse(ratesSchema, req.body);
    await db.transaction(async (tx) => {
      const panel = await tx.queryOne<{ code: string }>('SELECT code FROM "Panel" WHERE "facilityId" = :fid AND id = $1', [panelId]);
      if (!panel) throw notFound("Panel");
      await tx.execute('DELETE FROM "PanelItemRate" WHERE "facilityId" = :fid AND "panelId" = $1', [panelId]);
      for (const r of rates) {
        const exists = await tx.queryOne(
          r.kind === "service"
            ? 'SELECT 1 FROM "Service" WHERE "facilityId" = :fid AND id = $1'
            : 'SELECT 1 FROM "Investigation" WHERE "facilityId" = :fid AND id = $1',
          [r.itemId],
        );
        if (!exists) throw notFound(r.kind === "service" ? "Service" : "Investigation");
        await tx.execute('INSERT INTO "PanelItemRate" ("facilityId", "panelId", "itemKind", "itemId", rate) VALUES (:fid, $1,$2,$3,$4)', [panelId, r.kind, r.itemId, r.rate]);
      }
      await recordAudit(tx, actorOf(req), "Panel Item Rates Updated", `${panel.code}: ${rates.length} rate(s)`);
    });
    res.json({ saved: rates.length });
  });

  return router;
}

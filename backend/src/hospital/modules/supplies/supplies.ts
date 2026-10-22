import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Non-pharmacy supplies (surgical consumables, PPE, linen, equipment, stationery, diagnostic consumables).
 * Stock only changes through issue / restock, and every change leaves a line in SupplyLog.
 */
export const SUPPLY_CATEGORIES = ["Surgical Consumables", "PPE", "Linen & Housekeeping", "Equipment", "Stationery & Admin", "Diagnostic Consumables"] as const;

export interface SupplyRow {
  id: string;
  name: string;
  category: (typeof SUPPLY_CATEGORIES)[number];
  unit: string;
  stock: number;
  reorderLevel: number;
  location: string;
  lastRestockedAt: string;
}

export interface SupplyLogRow {
  id: number;
  supplyId: string;
  supplyName: string;
  type: "issue" | "restock";
  qty: number;
  department: string;
  at: string;
  by: string;
}

const COLUMNS = 'id, name, category, unit, stock, "reorderLevel", location, "lastRestockedAt"';

const newSupplySchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(SUPPLY_CATEGORIES),
  unit: z.string().trim().min(1).max(30),
  stock: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(0),
  location: z.string().trim().min(1).max(80),
});
const quantitySchema = z.object({ qty: z.number().int().min(1).max(1_000_000) });
const issueSchema = quantitySchema.extend({ department: z.string().trim().min(1).max(80) });

const lockSupply = (db: Queryable, id: string) => db.queryOne<SupplyRow>(`SELECT ${COLUMNS} FROM "Supply" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`, [id]);

export function suppliesRouter({ db }: HospitalContext): Router {
  const router = Router();
  const store = requireRole("front_office", "admin"); // whoever runs the store room
  const requesters = requireRole("front_office", "nurse", "admin");

  // ?lowStock=true returns only items at or below their reorder level.
  router.get("/", async (req, res) => {
    const { lowStock } = parse(z.object({ lowStock: z.enum(["true", "false"]).default("false") }), req.query);
    res.json(
      await db.query<SupplyRow>(`SELECT ${COLUMNS} FROM "Supply" WHERE "facilityId" = :fid AND ($1::boolean = false OR stock <= "reorderLevel") ORDER BY category, name`, [
        lowStock === "true",
      ]),
    );
  });

  router.get("/log", async (req, res) => {
    const { supplyId, limit } = parse(z.object({ supplyId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json(
      await db.query<SupplyLogRow>(
        `SELECT l.id, l."supplyId", s.name AS supply_name, l.type, l.qty, l.department, l.at, l.by
           FROM "SupplyLog" l JOIN "Supply" s ON s.id = l."supplyId"
          WHERE l."facilityId" = :fid AND ($1::text IS NULL OR l."supplyId" = $1) ORDER BY l.id DESC LIMIT $2`,
        [supplyId ?? null, limit],
      ),
    );
  });

  router.post("/", store, async (req, res) => {
    const s = parse(newSupplySchema, req.body);
    const row = await db.transaction(async (tx) => {
      const created = await tx.queryOne<SupplyRow>(
        `INSERT INTO "Supply" ("facilityId", name, category, unit, stock, "reorderLevel", location) VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
        [s.name, s.category, s.unit, s.stock, s.reorderLevel, s.location],
      );
      await recordAudit(tx, actorOf(req), "Supply Item Added", s.name);
      return created;
    });
    res.status(201).json(row);
  });

  // Hand stock out to a department. Refused if the store does not hold that many.
  router.post("/:id/issue", requesters, async (req, res) => {
    const id = uuidParam(req);
    const { qty, department } = parse(issueSchema, req.body);
    const row = await db.transaction(async (tx) => {
      const supply = await lockSupply(tx, id);
      if (!supply) throw notFound("Supply item");
      if (qty > supply.stock) throw conflict(`Only ${supply.stock} ${supply.unit} of ${supply.name} in stock`);
      const updated = await tx.queryOne<SupplyRow>(`UPDATE "Supply" SET stock = stock - $2 WHERE "facilityId" = :fid AND id = $1 RETURNING ${COLUMNS}`, [id, qty]);
      await tx.execute(`INSERT INTO "SupplyLog" ("facilityId", "supplyId", type, qty, department, by) VALUES (:fid, $1,'issue',$2,$3,$4)`, [id, qty, department, actorOf(req)]);
      await recordAudit(tx, actorOf(req), "Supply Issued", `${supply.name} x${qty} -> ${department}`);
      return updated;
    });
    res.json(row);
  });

  router.post("/:id/restock", store, async (req, res) => {
    const id = uuidParam(req);
    const { qty } = parse(quantitySchema, req.body);
    const row = await db.transaction(async (tx) => {
      const supply = await lockSupply(tx, id);
      if (!supply) throw notFound("Supply item");
      const updated = await tx.queryOne<SupplyRow>(
        `UPDATE "Supply" SET stock = stock + $2, "lastRestockedAt" = now() WHERE "facilityId" = :fid AND id = $1 RETURNING ${COLUMNS}`,
        [id, qty],
      );
      await tx.execute(`INSERT INTO "SupplyLog" ("facilityId", "supplyId", type, qty, department, by) VALUES (:fid, $1,'restock',$2,$3,$4)`, [id, qty, supply.location, actorOf(req)]);
      await recordAudit(tx, actorOf(req), "Supply Restocked", `${supply.name} +${qty}`);
      return updated;
    });
    res.json(row);
  });

  return router;
}

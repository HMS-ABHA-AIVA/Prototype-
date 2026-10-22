import { Router, type Request } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Bio-medical waste tracking per CPCB Bio-Medical Waste Management Rules 2016: segregate into a colour-coded bag,
 * store, optionally pre-treat onsite, then hand over to the authorised disposal vendor against a manifest number.
 * A batch only moves forward: segregated -> stored -> (pretreated) -> disposed.
 */
export type WasteCategory = "yellow" | "red" | "white" | "blue";
export type WasteStage = "segregated" | "stored" | "pretreated" | "disposed";

export interface WasteBatchRow {
  id: string;
  category: WasteCategory;
  department: string;
  weightKg: number;
  stage: WasteStage;
  segregatedAt: string;
  segregatedBy: string;
  storageLocation: string | null;
  storedAt: string | null;
  pretreatmentMethod: string | null;
  pretreatedAt: string | null;
  pretreatedBy: string | null;
  disposalVendor: string | null;
  manifestNo: string | null;
  disposedAt: string | null;
  disposedBy: string | null;
}

const COLUMNS = `id, category, department, "weightKg", stage, "segregatedAt", "segregatedBy", "storageLocation", "storedAt",
  "pretreatmentMethod", "pretreatedAt", "pretreatedBy", "disposalVendor", "manifestNo", "disposedAt", "disposedBy"`;

const segregateSchema = z.object({
  category: z.enum(["yellow", "red", "white", "blue"]),
  department: z.string().trim().min(1).max(80),
  weightKg: z.number().positive().max(10_000),
});
const storeSchema = z.object({ location: z.string().trim().min(1).max(120) });
const pretreatSchema = z.object({ method: z.string().trim().min(1).max(200) });
const disposeSchema = z.object({ vendor: z.string().trim().min(1).max(120), manifestNo: z.string().trim().min(1).max(60) });

const lockBatch = (db: Queryable, id: string) => db.queryOne<WasteBatchRow>(`SELECT ${COLUMNS} FROM "WasteBatch" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`, [id]);

export function wasteRouter({ db }: HospitalContext): Router {
  const router = Router();
  const handlers = requireRole("housekeeping", "nurse", "admin");

  router.get("/", async (req, res) => {
    const { stage } = parse(z.object({ stage: z.enum(["segregated", "stored", "pretreated", "disposed"]).optional() }), req.query);
    res.json(await db.query<WasteBatchRow>(`SELECT ${COLUMNS} FROM "WasteBatch" WHERE "facilityId" = :fid AND ($1::text IS NULL OR stage = $1) ORDER BY "segregatedAt" DESC`, [stage ?? null]));
  });

  // Total weight per colour category, for the daily/monthly BMW register.
  router.get("/summary", async (_req, res) => {
    res.json(
      await db.query(
        `SELECT category, count(*)::int AS batches, COALESCE(sum("weightKg"), 0)::float AS total_kg,
                count(*) FILTER (WHERE stage <> 'disposed')::int AS awaiting_disposal
           FROM "WasteBatch" WHERE "facilityId" = :fid GROUP BY category ORDER BY category`,
      ),
    );
  });

  router.post("/", handlers, async (req, res) => {
    const w = parse(segregateSchema, req.body);
    const row = await db.transaction(async (tx) => {
      const created = await tx.queryOne<WasteBatchRow>(
        `INSERT INTO "WasteBatch" ("facilityId", category, department, "weightKg", "segregatedBy") VALUES (:fid, $1,$2,$3,$4) RETURNING ${COLUMNS}`,
        [w.category, w.department, w.weightKg, actorOf(req)],
      );
      await recordAudit(tx, actorOf(req), "Waste Segregated", `${w.category.toUpperCase()} bag, ${w.weightKg}kg — ${w.department}`);
      return created;
    });
    res.status(201).json(row);
  });

  /** Moves a batch one step forward, refusing any other starting stage. */
  async function advance(
    req: Request,
    from: WasteStage[],
    action: string,
    apply: (tx: Queryable, id: string, batch: WasteBatchRow) => Promise<unknown>,
    detail: (batch: WasteBatchRow) => string,
  ) {
    const id = uuidParam(req);
    return db.transaction(async (tx) => {
      const batch = await lockBatch(tx, id);
      if (!batch) throw notFound("Waste batch");
      if (!from.includes(batch.stage)) throw conflict(`This batch is ${batch.stage}; it must be ${from.join(" or ")} for that step`);
      await apply(tx, id, batch);
      await recordAudit(tx, actorOf(req), action, detail(batch));
      return tx.queryOne<WasteBatchRow>(`SELECT ${COLUMNS} FROM "WasteBatch" WHERE "facilityId" = :fid AND id = $1`, [id]);
    });
  }

  router.post("/:id/store", handlers, async (req, res) => {
    const { location } = parse(storeSchema, req.body);
    res.json(
      await advance(
        req,
        ["segregated"],
        "Waste Moved to Storage",
        (tx, id) => tx.execute(`UPDATE "WasteBatch" SET stage='stored', "storageLocation"=$2, "storedAt"=now() WHERE "facilityId" = :fid AND id=$1`, [id, location]),
        (b) => `${b.category.toUpperCase()} batch -> ${location}`,
      ),
    );
  });

  router.post("/:id/pretreat", handlers, async (req, res) => {
    const { method } = parse(pretreatSchema, req.body);
    res.json(
      await advance(
        req,
        ["stored"],
        "Waste Pre-treated Onsite",
        (tx, id) =>
          tx.execute(`UPDATE "WasteBatch" SET stage='pretreated', "pretreatmentMethod"=$2, "pretreatedAt"=now(), "pretreatedBy"=$3 WHERE "facilityId" = :fid AND id=$1`, [
            id, method, actorOf(req),
          ]),
        (b) => `${b.category.toUpperCase()} batch — ${method}`,
      ),
    );
  });

  router.post("/:id/dispose", handlers, async (req, res) => {
    const { vendor, manifestNo } = parse(disposeSchema, req.body);
    res.json(
      await advance(
        req,
        ["stored", "pretreated"],
        "Waste Handed Over for Disposal",
        (tx, id) =>
          tx.execute(
            `UPDATE "WasteBatch" SET stage='disposed', "disposalVendor"=$2, "manifestNo"=$3, "disposedAt"=now(), "disposedBy"=$4 WHERE "facilityId" = :fid AND id=$1`,
            [id, vendor, manifestNo, actorOf(req)],
          ),
        (b) => `${b.category.toUpperCase()} batch -> ${vendor} (manifest ${manifestNo})`,
      ),
    );
  });

  return router;
}

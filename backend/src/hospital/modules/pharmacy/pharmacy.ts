import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { suggestedQuantity } from "./gst.js";
import { cancelPurchase, createPurchase, findSupplier, getPurchase, listPurchases, listSuppliers, paySupplier } from "./purchases.js";
import { gstr1, pharmacyDashboard, profitAndLoss, stockReport } from "./reports.js";
import { cancelSale, createCounterSale, dispensePrescription, getSale, listSales } from "./sales.js";
import { BATCH_COLUMNS, moveStock, SELLABLE_STOCK, TODAY_IST, type BatchRow } from "./stock.js";
import { scheduledTimesFor } from "./ward-medicine.js";

/**
 * Pharmacy. Medicines are items (name, unit, reorder level, GST, HSN) whose stock is held in batches with their own expiry and price. Stock comes in by
 * purchases from suppliers and goes out by counter sales and by dispensing prescriptions; every change is in the stock ledger.
 */
/** The stock list of the hospital in scope; callers add `AND ...` conditions. */
const DRUG_SELECT = `SELECT d.id, d.name, d.unit, d."reorderLevel",
       COALESCE((SELECT mrp FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.qty > 0 AND b.expiry >= ${TODAY_IST} ORDER BY b.expiry LIMIT 1), d.mrp)::float8 AS mrp,
       d.mrp::float8 AS default_mrp, d."gstPct"::float8 AS "gstPct", COALESCE(d."hsnCode", '3004') AS "hsnCode",
       ${SELLABLE_STOCK} AS stock,
       COALESCE((SELECT sum(qty) FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.expiry < ${TODAY_IST}), 0)::int AS expired_qty,
       (SELECT "batchNo" FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.qty > 0 AND b.expiry >= ${TODAY_IST} ORDER BY b.expiry LIMIT 1) AS batch,
       (SELECT expiry FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.qty > 0 AND b.expiry >= ${TODAY_IST} ORDER BY b.expiry LIMIT 1) AS expiry,
       (SELECT count(*) FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.qty > 0)::int AS batches
  FROM "Drug" d
 WHERE d."facilityId" = :fid`;

export interface DrugItem {
  id: string;
  name: string;
  unit: string;
  reorderLevel: number;
  mrp: number;
  defaultMrp: number;
  gstPct: number;
  hsnCode: string;
  stock: number;
  expiredQty: number;
  batch: string | null;
  expiry: string | null;
  batches: number;
}

const itemFields = {
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(20),
  reorderLevel: z.number().int().min(0).max(1_000_000),
  mrp: z.number().min(0).max(1_000_000),
  gstPct: z.number().min(0).max(100),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "The HSN code is 4 to 8 digits"),
};
const newDrugSchema = z
  .object({
    ...itemFields,
    reorderLevel: itemFields.reorderLevel.default(0),
    gstPct: itemFields.gstPct.default(12),
    hsnCode: itemFields.hsnCode.default("3004"),
    // Opening stock may be entered with the item (all three together). Normally stock comes in through a purchase.
    batch: z.string().trim().min(1).max(60).optional(),
    expiry: z.iso.date().optional(),
    stock: z.number().int().min(0).optional(),
  })
  .refine((d) => (d.batch === undefined) === (d.expiry === undefined) && (d.batch === undefined) === (d.stock === undefined), {
    message: "Give the batch, expiry and stock together, or none of them",
  });
const updateDrugSchema = z.object(itemFields).partial();

const paymentModes = z.enum(["cash", "upi", "card", "other"]);
const dateParam = z.iso.date();
const counterSaleSchema = z.object({
  patientId: z.uuid().optional(),
  customerName: z.string().trim().max(120).optional(),
  customerPhone: z.string().trim().max(20).optional(),
  discountPct: z.number().min(0).max(100).default(0),
  items: z.array(z.object({ drugId: z.uuid(), qty: z.number().int().min(1).max(5000), batchId: z.uuid().optional() })).min(1).max(60),
  payment: z.object({ mode: paymentModes, reference: z.string().trim().max(60).optional(), amountReceived: z.number().min(0).optional() }),
});
const supplierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "A GSTIN is 15 characters, e.g. 27ABCDE1234F1Z5")
    .nullable()
    .optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  drugLicense: z.string().trim().max(60).nullable().optional(),
  active: z.boolean().optional(),
});
const purchaseItem = z.object({
  drugId: z.uuid().optional(),
  newDrug: z
    .object({
      name: itemFields.name,
      unit: itemFields.unit,
      reorderLevel: itemFields.reorderLevel.default(0),
      gstPct: itemFields.gstPct,
      hsnCode: itemFields.hsnCode.optional(),
      mrp: itemFields.mrp,
    })
    .optional(),
  batchNo: z.string().trim().min(1).max(60),
  expiry: z.iso.date(),
  qty: z.number().int().min(1).max(1_000_000),
  freeQty: z.number().int().min(0).max(1_000_000).default(0),
  purchaseRate: z.number().min(0).max(1_000_000),
  mrp: z.number().min(0).max(1_000_000),
  gstPct: z.number().min(0).max(100).optional(),
});
const purchaseSchema = z.object({
  supplierId: z.uuid(),
  supplierInvoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: dateParam,
  notes: z.string().trim().max(300).optional(),
  payment: z.object({ amount: z.number().min(0), mode: z.enum(["cash", "upi", "card", "bank", "other"]), reference: z.string().trim().max(60).optional() }).optional(),
  items: z.array(purchaseItem).min(1).max(200),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(200) });

const itemOf = (db: Queryable, id: string) => db.queryOne<DrugItem>(`${DRUG_SELECT} AND d.id = $1`, [id]);

export function pharmacyRouter({ db }: HospitalContext): Router {
  const router = Router();
  const counter = requireRole("pharmacist", "admin");

  // ---- the item list and alerts (the clinical staff can look up what is in stock) --------------------------------------------
  router.get("/drugs", async (req, res) => {
    const { search } = parse(z.object({ search: z.string().trim().max(80).optional() }), req.query);
    res.json(await db.query<DrugItem>(`${DRUG_SELECT} AND ($1::text IS NULL OR d.name ILIKE '%' || $1 || '%') ORDER BY d.name`, [search || null]));
  });

  router.get("/alerts", async (_req, res) => {
    res.json({
      lowStock: await db.query<DrugItem>(`${DRUG_SELECT} AND ${SELLABLE_STOCK} <= d."reorderLevel" ORDER BY d.name`),
      expiringSoon: await db.query(
        `SELECT d.id AS "drugId", d.name, b.id AS "batchId", b."batchNo", b.expiry, b.qty, d.unit FROM "DrugBatch" b JOIN "Drug" d ON d.id = b."drugId"
          WHERE b."facilityId" = :fid AND b.qty > 0 AND b.expiry <= ${TODAY_IST} + 90 ORDER BY b.expiry`,
      ),
    });
  });

  router.get("/drugs/:id/batches", async (req, res) => {
    res.json(await db.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM "DrugBatch" WHERE "facilityId" = :fid AND "drugId" = $1 ORDER BY expiry`, [uuidParam(req)]));
  });

  // ---- items ------------------------------------------------------------------------------------------------------------------
  router.post("/drugs", counter, async (req, res) => {
    const d = parse(newDrugSchema, req.body);
    const item = await db.transaction(async (tx) => {
      if (await tx.queryOne('SELECT 1 FROM "Drug" WHERE "facilityId" = :fid AND lower(name) = lower($1)', [d.name])) throw conflict(`${d.name} is already in the stock list`);
      const created = await tx.queryOne<{ id: string }>(
        'INSERT INTO "Drug" ("facilityId", name, unit, "reorderLevel", mrp, "gstPct", "hsnCode") VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING id',
        [d.name, d.unit, d.reorderLevel, d.mrp, d.gstPct, d.hsnCode],
      );
      if (d.batch && d.expiry && d.stock) {
        const batch = await tx.queryOne<{ id: string }>(
          'INSERT INTO "DrugBatch" ("facilityId", "drugId", "batchNo", expiry, qty, mrp) VALUES (:fid, $1,$2,$3,0,$4) RETURNING id',
          [created!.id, d.batch, d.expiry, d.mrp],
        );
        await moveStock(tx, { id: batch!.id, drugId: created!.id }, d.stock, "opening", actorOf(req), { reason: "Opening stock" });
      }
      await recordAudit(tx, actorOf(req), "Drug Added", d.name);
      return itemOf(tx, created!.id);
    });
    res.status(201).json(item);
  });

  router.patch("/drugs/:id", counter, async (req, res) => {
    const id = uuidParam(req);
    const change = parse(updateDrugSchema, req.body);
    res.json(
      await db.transaction(async (tx) => {
        const current = await itemOf(tx, id);
        if (!current) throw notFound("Medicine");
        const n = { ...current, ...change };
        if (change.name && (await tx.queryOne('SELECT 1 FROM "Drug" WHERE "facilityId" = :fid AND lower(name) = lower($1) AND id <> $2', [n.name, id]))) {
          throw conflict(`${n.name} is already in the stock list`);
        }
        await tx.execute('UPDATE "Drug" SET name=$2, unit=$3, "reorderLevel"=$4, mrp=$5, "gstPct"=$6, "hsnCode"=$7 WHERE "facilityId" = :fid AND id=$1', [
          id, n.name, n.unit, n.reorderLevel, change.mrp ?? current.defaultMrp, n.gstPct, n.hsnCode,
        ]);
        await recordAudit(tx, actorOf(req), "Drug Updated", `${n.name}${change.gstPct !== undefined ? ` GST ${current.gstPct}% -> ${n.gstPct}%` : ""}`);
        return itemOf(tx, id);
      }),
    );
  });

  // Kept for older callers: adds units to the batch received last. New stock should be entered as a purchase.
  router.post("/drugs/:id/restock", counter, async (req, res) => {
    const { quantity } = parse(z.object({ quantity: z.number().int().min(1) }), req.body);
    res.json(
      await db.transaction(async (tx) => {
        const id = uuidParam(req);
        const batch = await tx.queryOne<BatchRow>(
          `SELECT ${BATCH_COLUMNS} FROM "DrugBatch" WHERE "facilityId" = :fid AND "drugId" = $1 ORDER BY "receivedAt" DESC LIMIT 1 FOR UPDATE`,
          [id],
        );
        if (!batch) throw conflict("This medicine has no batch yet: enter a purchase");
        await moveStock(tx, { id: batch.id, drugId: id }, quantity, "adjustment", actorOf(req), { reason: "Restock" });
        const item = await itemOf(tx, id);
        await recordAudit(tx, actorOf(req), "Drug Restocked", `${item!.name} +${quantity}`);
        return item;
      }),
    );
  });

  // ---- stock, valuation and the ledger -----------------------------------------------------------------------------------
  router.get("/dashboard", counter, async (_req, res) => {
    res.json(await pharmacyDashboard(db));
  });

  router.get("/stock", counter, async (req, res) => {
    const { includeEmpty } = parse(z.object({ includeEmpty: z.enum(["true", "false"]).default("false") }), req.query);
    res.json(await stockReport(db, { includeEmpty: includeEmpty === "true" }));
  });

  // Writes stock off (damage, expiry, a count that did not match) or corrects it, with the reason on the ledger.
  router.post("/batches/:id/adjust", counter, async (req, res) => {
    const { delta, reason } = parse(
      z.object({ delta: z.number().int().refine((n) => n !== 0, "Enter a change that is not zero"), reason: z.string().trim().min(3).max(200) }),
      req.body,
    );
    res.json(
      await db.transaction(async (tx) => {
        const batch = await tx.queryOne<BatchRow & { name: string }>(
          `SELECT b.id, b."drugId", b."batchNo", b.expiry, b.qty, b.mrp::float8 AS mrp, b."purchaseRate"::float8 AS "purchaseRate", b."receivedAt", d.name
             FROM "DrugBatch" b JOIN "Drug" d ON d.id = b."drugId" WHERE b."facilityId" = :fid AND b.id = $1 FOR UPDATE OF b`,
          [uuidParam(req)],
        );
        if (!batch) throw notFound("Batch");
        if (batch.qty + delta < 0) throw badRequest(`Only ${batch.qty} in this batch`);
        await moveStock(tx, { id: batch.id, drugId: batch.drugId }, delta, "adjustment", actorOf(req), { reason });
        await recordAudit(tx, actorOf(req), "Stock Adjusted", `${batch.name} batch ${batch.batchNo}: ${delta > 0 ? "+" : ""}${delta} (${reason})`);
        return tx.queryOne<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM "DrugBatch" WHERE "facilityId" = :fid AND id = $1`, [batch.id]);
      }),
    );
  });

  router.get("/stock-ledger", counter, async (req, res) => {
    const { drugId, limit } = parse(z.object({ drugId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json(
      await db.query(
        `SELECT l.id, l.at, d.name AS "drugName", b."batchNo", l.delta, l.kind, l.reason, l.by
           FROM "StockLedger" l JOIN "DrugBatch" b ON b.id = l."batchId" JOIN "Drug" d ON d.id = l."drugId"
          WHERE l."facilityId" = :fid AND ($1::text IS NULL OR l."drugId" = $1) ORDER BY l.id DESC LIMIT $2`,
        [drugId ?? null, limit],
      ),
    );
  });

  // ---- suppliers and purchases ---------------------------------------------------------------------------------------------
  router.get("/suppliers", counter, async (req, res) => {
    const all = parse(z.object({ all: z.enum(["true", "false"]).default("false") }), req.query).all === "true";
    res.json(await listSuppliers(db, all));
  });
  router.post("/suppliers", counter, async (req, res) => {
    const s = parse(supplierSchema, req.body);
    const row = await db.transaction(async (tx) => {
      if (await tx.queryOne('SELECT 1 FROM "Supplier" WHERE "facilityId" = :fid AND lower(name) = lower($1)', [s.name])) throw conflict(`${s.name} is already a supplier`);
      const created = await tx.queryOne<{ id: string }>(
        'INSERT INTO "Supplier" ("facilityId", name, gstin, phone, address, "drugLicense") VALUES (:fid, $1,$2,$3,$4,$5) RETURNING id',
        [s.name, s.gstin ?? null, s.phone ?? null, s.address ?? null, s.drugLicense ?? null],
      );
      await recordAudit(tx, actorOf(req), "Supplier Added", s.name);
      return findSupplier(tx, created!.id);
    });
    res.status(201).json(row);
  });
  router.patch("/suppliers/:id", counter, async (req, res) => {
    const id = uuidParam(req);
    const change = parse(supplierSchema.partial(), req.body);
    res.json(
      await db.transaction(async (tx) => {
        const current = await findSupplier(tx, id);
        if (!current) throw notFound("Supplier");
        const n = { ...current, ...change };
        await tx.execute('UPDATE "Supplier" SET name=$2, gstin=$3, phone=$4, address=$5, "drugLicense"=$6, active=$7 WHERE "facilityId" = :fid AND id=$1', [
          id, n.name, n.gstin ?? null, n.phone ?? null, n.address ?? null, n.drugLicense ?? null, n.active,
        ]);
        await recordAudit(tx, actorOf(req), "Supplier Updated", n.name ?? current.name);
        return findSupplier(tx, id);
      }),
    );
  });

  router.get("/purchases", counter, async (req, res) => {
    const q = parse(
      z.object({
        from: dateParam.optional(),
        to: dateParam.optional(),
        supplierId: z.uuid().optional(),
        status: z.enum(["received", "cancelled"]).optional(),
        unpaid: z.enum(["true", "false"]).default("false"),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    res.json(await listPurchases(db, { ...q, unpaid: q.unpaid === "true" }));
  });
  router.get("/purchases/:id", counter, async (req, res) => {
    const purchase = await getPurchase(db, uuidParam(req));
    if (!purchase) throw notFound("Purchase");
    res.json(purchase);
  });
  router.post("/purchases", counter, async (req, res) => {
    const input = parse(purchaseSchema, req.body);
    res.status(201).json(await db.transaction((tx) => createPurchase(tx, input, actorOf(req))));
  });
  router.post("/purchases/:id/cancel", counter, async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json(await db.transaction((tx) => cancelPurchase(tx, uuidParam(req), reason, actorOf(req))));
  });
  router.post("/purchases/:id/payment", counter, async (req, res) => {
    const payment = parse(
      z.object({ amount: z.number().positive(), mode: z.enum(["cash", "upi", "card", "bank", "other"]), reference: z.string().trim().max(60).optional() }),
      req.body,
    );
    res.json(await db.transaction((tx) => paySupplier(tx, uuidParam(req), payment, actorOf(req))));
  });

  // ---- counter sales ----------------------------------------------------------------------------------------------------------
  router.get("/sales", counter, async (req, res) => {
    const q = parse(
      z.object({
        from: dateParam.optional(),
        to: dateParam.optional(),
        kind: z.enum(["counter", "encounter"]).optional(),
        status: z.enum(["paid", "cancelled"]).optional(),
        search: z.string().trim().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    res.json(await listSales(db, q));
  });
  router.get("/sales/:id", counter, async (req, res) => {
    const sale = await getSale(db, uuidParam(req));
    if (!sale) throw notFound("Sale");
    res.json(sale);
  });
  router.post("/sales", counter, async (req, res) => {
    const input = parse(counterSaleSchema, req.body);
    res.status(201).json(await db.transaction((tx) => createCounterSale(tx, input, actorOf(req))));
  });
  router.post("/sales/:id/cancel", counter, async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json(await db.transaction((tx) => cancelSale(tx, uuidParam(req), reason, actorOf(req))));
  });

  // ---- the dispense queue: prescriptions waiting at the pharmacy -------------------------------------------------------------------
  router.get("/queue", counter, async (_req, res) => {
    const rows = await db.query<{
      id: string; drugName: string; dose: string; frequency: string; duration: string; encounterId: string; encounterType: string; patientId: string; patientName: string;
      mrn: string; stock: number | null; unit: string | null; mrp: number | null;
    }>(
      `SELECT p.id, p."drugName", p.dose, p.frequency, p.duration, e.id AS "encounterId", e.type AS encounter_type, pt.id AS "patientId", pt.name AS patient_name, pt.mrn,
              CASE WHEN d.id IS NULL THEN NULL ELSE ${SELLABLE_STOCK} END AS stock, d.unit,
              COALESCE((SELECT mrp FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.qty > 0 AND b.expiry >= ${TODAY_IST} ORDER BY b.expiry LIMIT 1), d.mrp)::float8 AS mrp
         FROM "Prescription" p
         JOIN "Encounter" e ON e.id = p."encounterId"
         JOIN "Patient" pt ON pt.id = e."patientId"
         LEFT JOIN "Drug" d ON d."facilityId" = :fid AND lower(d.name) = lower(p."drugName")
        WHERE p."facilityId" = :fid AND NOT p.dispensed ORDER BY p."createdAt"`,
    );
    const scheduled = await scheduledTimesFor(db, rows.map((r) => r.id));
    res.json(
      rows.map((r) => {
        const plan = scheduled.get(r.id);
        const perDay = plan?.times.length;
        return {
          ...r,
          listed: r.stock !== null,
          scheduledTimes: plan?.times ?? null,
          suggestedQty: perDay && plan?.days ? perDay * plan.days : suggestedQuantity(r.frequency, r.duration),
        };
      }),
    );
  });

  router.post("/prescriptions/:id/dispense", counter, async (req, res) => {
    const id = uuidParam(req);
    const { quantity } = parse(z.object({ quantity: z.number().int().min(1).max(5000).default(1) }), req.body ?? {});
    res.json(await db.transaction((tx) => dispensePrescription(tx, id, quantity, actorOf(req))));
  });

  // ---- reports ----------------------------------------------------------------------------------------------------------------------
  const periodQuery = z.object({ from: dateParam, to: dateParam });
  router.get("/reports/gstr1", counter, async (req, res) => {
    const { from, to } = parse(periodQuery, req.query);
    res.json(await gstr1(db, from, to));
  });
  router.get("/reports/profit-loss", counter, async (req, res) => {
    const { from, to } = parse(periodQuery, req.query);
    res.json(await profitAndLoss(db, from, to));
  });

  return router;
}

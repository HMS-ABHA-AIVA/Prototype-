import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { billLateMedicines } from "../billing/billing.service.js";
import { getSettings } from "../masters/settings.js";
import { priceLine, round2, splitTax } from "./gst.js";
import { allocateStock, moveStock, SELLABLE_STOCK } from "./stock.js";

/**
 * Sales of medicines. A *counter sale* (walk-in customer or a patient buying over the counter) gets its own invoice (PH-n). A *dispense* hands over a
 * medicine prescribed on a visit (DISP-n): it is billed on that visit's bill, not invoiced separately. Both take stock from the batches that expire
 * first, price each line at its batch's MRP (which includes the GST), and are the source for the GST return and the profit report.
 */
export type PaymentMode = "cash" | "upi" | "card" | "other";

export interface SaleItem {
  id: string;
  saleId: string;
  drugId: string | null;
  batchId: string | null;
  prescriptionId: string | null;
  drugName: string;
  batchNo: string | null;
  expiry: string | null;
  hsnCode: string;
  qty: number;
  mrp: number;
  gstPct: number;
  lineTotal: number;
  taxable: number;
  tax: number;
  cost: number | null;
}

export interface TaxRow {
  gstPct: number;
  taxable: number;
  cgst: number;
  sgst: number;
  total: number;
}

const SALE_COLUMNS = `s.id, s.kind, s."invoiceNo", s."encounterId", s."patientId", p.name AS patient_name, p.mrn, s."customerName", s."customerPhone",
  s."discountPct"::float8 AS "discountPct", s.taxable::float8 AS taxable, s.tax::float8 AS tax, s.total::float8 AS total, s."paymentMode", s."paymentReference",
  s."amountReceived"::float8 AS "amountReceived", s.status, s."soldBy", s."soldAt", s."cancelledAt", s."cancelReason", s."cancelledBy"`;
const SALE_FROM = '/* fragment: every caller adds s."facilityId" = :fid */ FROM "PharmacySale" s LEFT JOIN "Patient" p ON p.id = s."patientId"';
const ITEM_COLUMNS = `id, "saleId", "drugId", "batchId", "prescriptionId", "drugName", "batchNo", expiry, "hsnCode", qty, mrp::float8 AS mrp, "gstPct"::float8 AS "gstPct",
  "lineTotal"::float8 AS "lineTotal", taxable::float8 AS taxable, tax::float8 AS tax, cost::float8 AS cost`;

export interface SaleRow {
  id: string;
  kind: "counter" | "encounter";
  invoiceNo: string;
  encounterId: string | null;
  patientId: string | null;
  patientName: string | null;
  mrn: string | null;
  customerName: string | null;
  customerPhone: string | null;
  discountPct: number;
  taxable: number;
  tax: number;
  total: number;
  paymentMode: PaymentMode | null;
  paymentReference: string | null;
  amountReceived: number | null;
  status: "paid" | "cancelled";
  soldBy: string;
  soldAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
}

/** The GST of a set of lines by rate, with the tax shared between CGST and SGST. */
export function taxSummary(items: { gstPct: number; taxable: number; tax: number; lineTotal: number }[]): TaxRow[] {
  const by = new Map<number, { taxable: number; tax: number; total: number }>();
  for (const i of items) {
    const row = by.get(i.gstPct) ?? { taxable: 0, tax: 0, total: 0 };
    by.set(i.gstPct, { taxable: round2(row.taxable + i.taxable), tax: round2(row.tax + i.tax), total: round2(row.total + i.lineTotal) });
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([gstPct, r]) => ({ gstPct, taxable: r.taxable, ...splitTax(r.tax), total: r.total }));
}

export async function getSale(db: Queryable, id: string) {
  const sale = await db.queryOne<SaleRow>(`SELECT ${SALE_COLUMNS} ${SALE_FROM} WHERE s."facilityId" = :fid AND s.id = $1`, [id]);
  if (!sale) return null;
  const items = await db.query<SaleItem>(`SELECT ${ITEM_COLUMNS} FROM "PharmacySaleItem" WHERE "facilityId" = :fid AND "saleId" = $1 ORDER BY "drugName", "batchNo"`, [id]);
  const change = sale.amountReceived !== null && sale.paymentMode === "cash" ? round2(Math.max(0, sale.amountReceived - sale.total)) : null;
  return { ...sale, items, tax: sale.tax, taxSummary: taxSummary(items), change };
}
export type SaleDto = NonNullable<Awaited<ReturnType<typeof getSale>>>;

export async function listSales(
  db: Queryable,
  f: { from?: string | undefined; to?: string | undefined; kind?: "counter" | "encounter" | undefined; status?: "paid" | "cancelled" | undefined; search?: string | undefined; limit: number },
) {
  const rows = await db.query<SaleRow & { itemCount: number }>(
    `SELECT ${SALE_COLUMNS}, (SELECT count(*)::int FROM "PharmacySaleItem" i WHERE i."facilityId" = :fid AND i."saleId" = s.id) AS item_count
       ${SALE_FROM}
      WHERE s."facilityId" = :fid
        AND ($1::date IS NULL OR (s."soldAt" AT TIME ZONE 'Asia/Kolkata')::date >= $1) AND ($2::date IS NULL OR (s."soldAt" AT TIME ZONE 'Asia/Kolkata')::date <= $2)
        AND ($3::text IS NULL OR s.kind = $3) AND ($4::text IS NULL OR s.status = $4)
        AND ($5::text IS NULL OR s."invoiceNo" ILIKE '%' || $5 || '%' OR s."customerName" ILIKE '%' || $5 || '%' OR p.name ILIKE '%' || $5 || '%' OR p.mrn ILIKE '%' || $5 || '%')
      ORDER BY s."soldAt" DESC LIMIT $6`,
    [f.from ?? null, f.to ?? null, f.kind ?? null, f.status ?? null, f.search || null, f.limit],
  );
  const live = rows.filter((r) => r.status === "paid");
  return {
    sales: rows,
    totals: {
      count: live.length,
      taxable: round2(live.reduce((s, r) => s + r.taxable, 0)),
      tax: round2(live.reduce((s, r) => s + r.tax, 0)),
      total: round2(live.reduce((s, r) => s + r.total, 0)),
    },
  };
}

interface DrugForSale {
  id: string;
  name: string;
  gstPct: number;
  hsnCode: string;
}
const findDrug = (db: Queryable, id: string) =>
  db.queryOne<DrugForSale>('SELECT id, name, "gstPct"::float8 AS "gstPct", COALESCE("hsnCode", \'3004\') AS "hsnCode" FROM "Drug" WHERE "facilityId" = :fid AND id = $1', [id]);

/** Takes `qty` of a medicine from stock into the sale, one line per batch used. Returns what it added to the sale. */
async function addStockLines(
  tx: Queryable,
  saleId: string,
  drug: DrugForSale,
  qty: number,
  discountPct: number,
  actor: string,
  kind: "sale" | "dispense",
  batchId?: string,
  prescriptionId?: string,
) {
  const allocations = await allocateStock(tx, drug.id, drug.name, qty, batchId);
  const lines = [];
  for (const { batch, qty: take } of allocations) {
    const price = priceLine(take, batch.mrp, drug.gstPct, discountPct);
    await tx.execute(
      `INSERT INTO "PharmacySaleItem" ("facilityId", "saleId", "drugId", "batchId", "prescriptionId", "drugName", "batchNo", expiry, "hsnCode", qty, mrp, "gstPct", "lineTotal", taxable, tax, cost)
       VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        saleId, drug.id, batch.id, prescriptionId ?? null, drug.name, batch.batchNo, batch.expiry, drug.hsnCode, take, batch.mrp, drug.gstPct, price.lineTotal, price.taxable,
        price.tax, batch.purchaseRate === null ? null : round2(take * batch.purchaseRate),
      ],
    );
    await moveStock(tx, { id: batch.id, drugId: drug.id }, -take, kind, actor, { refId: saleId });
    lines.push(price);
  }
  return lines;
}

async function setTotals(tx: Queryable, saleId: string) {
  await tx.execute(
    `UPDATE "PharmacySale" SET taxable = t.taxable, tax = t.tax, total = t.total
       FROM (SELECT COALESCE(sum(taxable), 0) AS taxable, COALESCE(sum(tax), 0) AS tax, COALESCE(sum("lineTotal"), 0) AS total
               FROM "PharmacySaleItem" WHERE "facilityId" = :fid AND "saleId" = $1) t
      WHERE "facilityId" = :fid AND id = $1`,
    [saleId],
  );
}

export interface CounterSaleInput {
  patientId?: string | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  discountPct: number;
  items: { drugId: string; qty: number; batchId?: string | undefined }[];
  payment: { mode: PaymentMode; reference?: string | undefined; amountReceived?: number | undefined };
}

export async function createCounterSale(tx: Queryable, input: CounterSaleInput, actor: string) {
  const { mode, reference, amountReceived } = input.payment;
  if ((mode === "upi" || mode === "card") && (reference ?? "").trim().length < 3) {
    throw badRequest(mode === "upi" ? "Enter the UPI transaction id" : "Enter the card slip number or last digits");
  }
  if (input.patientId && !(await tx.queryOne('SELECT 1 FROM "Patient" WHERE "facilityId" = :fid AND id = $1', [input.patientId]))) throw notFound("Patient");

  const sale = (await tx.queryOne<{ id: string }>(
    `INSERT INTO "PharmacySale" ("facilityId", kind, "invoiceNo", "patientId", "customerName", "customerPhone", "discountPct", "paymentMode", "paymentReference", "soldBy")
     VALUES (:fid, 'counter', 'PH-' || next_facility_number(:fid, 'pharmacy_invoice', 1), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.patientId ?? null, input.customerName?.trim() || null, input.customerPhone?.trim() || null, input.discountPct, mode, reference?.trim() || null, actor],
  ))!;
  for (const item of input.items) {
    const drug = await findDrug(tx, item.drugId);
    if (!drug) throw notFound("Medicine");
    await addStockLines(tx, sale.id, drug, item.qty, input.discountPct, actor, "sale", item.batchId);
  }
  await setTotals(tx, sale.id);
  const total = (await tx.queryOne<{ total: number }>('SELECT total::float8 AS total FROM "PharmacySale" WHERE "facilityId" = :fid AND id = $1', [sale.id]))!.total;
  if (mode === "cash" && amountReceived !== undefined) {
    if (amountReceived < total) throw badRequest("The cash received is less than the amount due");
    await tx.execute('UPDATE "PharmacySale" SET "amountReceived" = $2 WHERE "facilityId" = :fid AND id = $1', [sale.id, amountReceived]);
  }
  const done = (await getSale(tx, sale.id))!;
  await recordAudit(tx, actor, "Pharmacy Sale", `${done.invoiceNo}: ${done.items.length} line(s), Rs ${done.total} (${mode})`);
  return done;
}

/** An invoice made in error or a sale reversed: stock goes back to the batches it came from; the invoice stays on record as cancelled. */
export async function cancelSale(tx: Queryable, saleId: string, reason: string, actor: string) {
  const sale = await tx.queryOne<{ id: string; kind: string; status: string; invoiceNo: string }>(
    'SELECT id, kind, status, "invoiceNo" FROM "PharmacySale" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
    [saleId],
  );
  if (!sale) throw notFound("Sale");
  if (sale.kind !== "counter") throw conflict("A medicine handed over for a patient's visit is on that visit's bill and cannot be cancelled here");
  if (sale.status === "cancelled") throw conflict("That sale is already cancelled");
  if (reason.trim().length < 3) throw badRequest("Give a reason for cancelling the sale");
  const items = await tx.query<{ drugId: string | null; batchId: string | null; qty: number }>(
    'SELECT "drugId", "batchId", qty FROM "PharmacySaleItem" WHERE "facilityId" = :fid AND "saleId" = $1',
    [saleId],
  );
  for (const item of items) if (item.batchId && item.drugId) await moveStock(tx, { id: item.batchId, drugId: item.drugId }, item.qty, "sale_cancel", actor, { refId: saleId, reason });
  await tx.execute(`UPDATE "PharmacySale" SET status = 'cancelled', "cancelledAt" = now(), "cancelReason" = $2, "cancelledBy" = $3 WHERE "facilityId" = :fid AND id = $1`, [
    saleId, reason.trim(), actor,
  ]);
  await recordAudit(tx, actor, "Pharmacy Sale Cancelled", `${sale.invoiceNo}: ${reason.trim()}`);
  return (await getSale(tx, saleId))!;
}

/**
 * Hands over a prescribed medicine for a visit: takes `quantity` from stock (earliest expiry first), records the dispense, and marks the prescription
 * dispensed. A medicine that is not in the stock list can still be dispensed (nothing is taken off stock) and is charged at the hospital's "unlisted
 * medicine" price. The visit's bill picks the lines up.
 */
export async function dispensePrescription(tx: Queryable, prescriptionId: string, quantity: number, actor: string) {
  const rx = await tx.queryOne<{ id: string; encounterId: string; drugName: string; dispensed: boolean }>(
    'SELECT id, "encounterId", "drugName", dispensed FROM "Prescription" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
    [prescriptionId],
  );
  if (!rx) throw notFound("Prescription");
  if (rx.dispensed) throw conflict("This prescription has already been dispensed");
  const encounter = (await tx.queryOne<{ patientId: string }>('SELECT "patientId" FROM "Encounter" WHERE "facilityId" = :fid AND id = $1', [rx.encounterId]))!;

  const drug = await tx.queryOne<DrugForSale>(
    'SELECT id, name, "gstPct"::float8 AS "gstPct", COALESCE("hsnCode", \'3004\') AS "hsnCode" FROM "Drug" WHERE "facilityId" = :fid AND lower(name) = lower($1)',
    [rx.drugName],
  );
  const sale = (await tx.queryOne<{ id: string; invoiceNo: string }>(
    `INSERT INTO "PharmacySale" ("facilityId", kind, "invoiceNo", "encounterId", "patientId", "soldBy")
     VALUES (:fid, 'encounter', 'DISP-' || next_facility_number(:fid, 'dispense', 1), $1, $2, $3) RETURNING id, "invoiceNo"`,
    [rx.encounterId, encounter.patientId, actor],
  ))!;
  if (drug) {
    await addStockLines(tx, sale.id, drug, quantity, 0, actor, "dispense", undefined, rx.id);
  } else {
    const settings = await getSettings(tx);
    const price = priceLine(quantity, settings.unlistedMedicinePrice, settings.medicineGstPct);
    await tx.execute(
      `INSERT INTO "PharmacySaleItem" ("facilityId", "saleId", "prescriptionId", "drugName", qty, mrp, "gstPct", "lineTotal", taxable, tax)
       VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sale.id, rx.id, rx.drugName, quantity, settings.unlistedMedicinePrice, settings.medicineGstPct, price.lineTotal, price.taxable, price.tax],
    );
  }
  await setTotals(tx, sale.id);
  await tx.execute('UPDATE "Prescription" SET dispensed = true WHERE "facilityId" = :fid AND id = $1', [prescriptionId]);
  await recordAudit(tx, actor, "Prescription Dispensed", `${rx.drugName} x${quantity}`);
  // Handed over after the visit closed: onto the visit's bill (the bill is made at closing, from what was dispensed by then).
  const bill = await billLateMedicines(tx, rx.encounterId, actor);
  const remaining = drug ? (await tx.queryOne<{ n: number }>(`SELECT ${SELLABLE_STOCK} AS n FROM "Drug" d WHERE d."facilityId" = :fid AND d.id = $1`, [drug.id]))!.n : null;
  return {
    prescriptionId, drugName: rx.drugName, quantity, saleId: sale.id, invoiceNo: sale.invoiceNo, stockUpdated: !!drug, remainingStock: remaining,
    /** The visit's bill the medicine went on, when the visit had already closed; `billFinalised` when it could not be added. */
    billNo: bill.billNo, billFinalised: bill.alreadyFinalised,
  };
}

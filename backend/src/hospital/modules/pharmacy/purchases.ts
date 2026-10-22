import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { round2 } from "./gst.js";
import { BATCH_COLUMNS, moveStock, TODAY_IST, type BatchRow } from "./stock.js";

/**
 * Buying stock from suppliers. A purchase is the supplier's invoice entered: each line names a medicine, its batch number and expiry, the quantity (and
 * any free units), the price paid before GST, and the MRP printed on the pack. Receiving it puts the units into that batch (a new batch, or more of an
 * existing one) and writes the stock ledger. The supplier's own invoice number is entered once per supplier.
 */
export interface SupplierRow {
  id: string;
  name: string;
  gstin: string | null;
  phone: string | null;
  address: string | null;
  drugLicense: string | null;
  active: boolean;
}

const SUPPLIER_COLUMNS = 'id, name, gstin, phone, address, "drugLicense", active';
export const findSupplier = (db: Queryable, id: string) => db.queryOne<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM "Supplier" WHERE "facilityId" = :fid AND id = $1`, [id]);
export const listSuppliers = (db: Queryable, all: boolean) =>
  db.query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM "Supplier" WHERE "facilityId" = :fid AND ($1::boolean OR active) ORDER BY name`, [all]);

export interface NewDrug {
  name: string;
  unit: string;
  reorderLevel: number;
  gstPct: number;
  hsnCode?: string | undefined;
  mrp: number;
}
export interface PurchaseItemInput {
  drugId?: string | undefined;
  newDrug?: NewDrug | undefined;
  batchNo: string;
  expiry: string;
  qty: number;
  freeQty: number;
  purchaseRate: number;
  mrp: number;
  gstPct?: number | undefined;
}
export interface PurchaseInput {
  supplierId: string;
  supplierInvoiceNo: string;
  invoiceDate: string;
  notes?: string | undefined;
  payment?: { amount: number; mode: "cash" | "upi" | "card" | "bank" | "other"; reference?: string | undefined } | undefined;
  items: PurchaseItemInput[];
}

const PURCHASE_COLUMNS = `p.id, p."purchaseNo", p."supplierId", s.name AS supplier_name, p."supplierInvoiceNo", p."invoiceDate", p.taxable::float8 AS taxable,
  p."gstTotal"::float8 AS "gstTotal", p.total::float8 AS total, p."amountPaid"::float8 AS "amountPaid", p."paymentMode", p."paymentReference", p.notes, p.status,
  p."cancelReason", p."cancelledBy", p."cancelledAt", p."createdBy", p."createdAt"`;

export interface PurchaseRow {
  id: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string;
  invoiceDate: string;
  taxable: number;
  gstTotal: number;
  total: number;
  amountPaid: number;
  paymentMode: string | null;
  paymentReference: string | null;
  notes: string | null;
  status: "received" | "cancelled";
  cancelReason: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  createdBy: string;
  createdAt: string;
}

export async function getPurchase(db: Queryable, id: string) {
  const purchase = await db.queryOne<PurchaseRow>(
    `SELECT ${PURCHASE_COLUMNS} FROM "Purchase" p JOIN "Supplier" s ON s.id = p."supplierId" WHERE p."facilityId" = :fid AND p.id = $1`,
    [id],
  );
  if (!purchase) return null;
  const items = await db.query<{
    id: string; drugId: string; drugName: string; batchNo: string; expiry: string; qty: number; freeQty: number; purchaseRate: number; mrp: number; gstPct: number;
    taxable: number; gstAmount: number;
  }>(
    `SELECT i.id, i."drugId", d.name AS "drugName", i."batchNo", i.expiry, i.qty, i."freeQty", i."purchaseRate"::float8 AS "purchaseRate", i.mrp::float8 AS mrp,
            i."gstPct"::float8 AS "gstPct", i.taxable::float8 AS taxable, i."gstAmount"::float8 AS "gstAmount"
       FROM "PurchaseItem" i JOIN "Drug" d ON d.id = i."drugId" WHERE i."facilityId" = :fid AND i."purchaseId" = $1 ORDER BY d.name, i."batchNo"`,
    [id],
  );
  return { ...purchase, due: purchase.status === "cancelled" ? 0 : round2(purchase.total - purchase.amountPaid), items };
}
export type PurchaseDto = NonNullable<Awaited<ReturnType<typeof getPurchase>>>;

export async function listPurchases(
  db: Queryable,
  f: { from?: string | undefined; to?: string | undefined; supplierId?: string | undefined; status?: "received" | "cancelled" | undefined; unpaid?: boolean; limit: number },
) {
  const rows = await db.query<PurchaseRow>(
    `SELECT ${PURCHASE_COLUMNS} FROM "Purchase" p JOIN "Supplier" s ON s.id = p."supplierId"
      WHERE p."facilityId" = :fid AND ($1::date IS NULL OR p."invoiceDate" >= $1) AND ($2::date IS NULL OR p."invoiceDate" <= $2) AND ($3::text IS NULL OR p."supplierId" = $3)
        AND ($4::text IS NULL OR p.status = $4) AND (NOT $5::boolean OR (p.status = 'received' AND p."amountPaid" < p.total))
      ORDER BY p."invoiceDate" DESC, p."createdAt" DESC LIMIT $6`,
    [f.from ?? null, f.to ?? null, f.supplierId ?? null, f.status ?? null, f.unpaid ?? false, f.limit],
  );
  const live = rows.filter((r) => r.status === "received");
  return {
    purchases: rows.map((r) => ({ ...r, due: r.status === "cancelled" ? 0 : round2(r.total - r.amountPaid) })),
    totals: {
      count: live.length,
      taxable: round2(live.reduce((s, r) => s + r.taxable, 0)),
      gst: round2(live.reduce((s, r) => s + r.gstTotal, 0)),
      total: round2(live.reduce((s, r) => s + r.total, 0)),
      due: round2(live.reduce((s, r) => s + (r.total - r.amountPaid), 0)),
    },
  };
}

/** The medicine a purchase line is for: the one chosen, or the one named (found by name, or added to the stock list). */
async function drugFor(tx: Queryable, item: PurchaseItemInput): Promise<{ id: string; gstPct: number; name: string }> {
  if (item.drugId) {
    const drug = await tx.queryOne<{ id: string; gstPct: number; name: string }>('SELECT id, "gstPct"::float8 AS "gstPct", name FROM "Drug" WHERE "facilityId" = :fid AND id = $1', [
      item.drugId,
    ]);
    if (!drug) throw notFound("Medicine");
    return drug;
  }
  const n = item.newDrug!;
  const existing = await tx.queryOne<{ id: string; gstPct: number; name: string }>(
    'SELECT id, "gstPct"::float8 AS "gstPct", name FROM "Drug" WHERE "facilityId" = :fid AND lower(name) = lower($1)',
    [n.name.trim()],
  );
  if (existing) return existing;
  const created = await tx.queryOne<{ id: string; gstPct: number; name: string }>(
    `INSERT INTO "Drug" ("facilityId", name, unit, "reorderLevel", mrp, "gstPct", "hsnCode") VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING id, "gstPct"::float8 AS "gstPct", name`,
    [n.name.trim(), n.unit.trim(), n.reorderLevel, n.mrp, n.gstPct, n.hsnCode?.trim() || "3004"],
  );
  return created!;
}

export async function createPurchase(tx: Queryable, input: PurchaseInput, actor: string): Promise<PurchaseDto> {
  const supplier = await findSupplier(tx, input.supplierId);
  if (!supplier || !supplier.active) throw notFound("Supplier");
  if (input.items.some((i) => !i.drugId && !i.newDrug)) throw badRequest("Each line needs a medicine");
  const today = (await tx.queryOne<{ d: string }>(`SELECT ${TODAY_IST}::text AS d`))!.d;
  if (input.invoiceDate > today) throw badRequest("The supplier's invoice cannot be dated in the future");

  // The same supplier invoice cannot be entered twice (a cancelled one can be entered again). Checked first, so the clear message wins
  // over the unique index (which only backs it up).
  const duplicate = await tx.queryOne(
    `SELECT 1 FROM "Purchase" WHERE "facilityId" = :fid AND "supplierId" = $1 AND lower("supplierInvoiceNo") = lower($2) AND status = 'received'`,
    [input.supplierId, input.supplierInvoiceNo.trim()],
  );
  if (duplicate) throw conflict(`Invoice ${input.supplierInvoiceNo.trim()} from ${supplier.name} has already been entered`);
  const purchaseId = (await tx.queryOne<{ id: string }>(
    `INSERT INTO "Purchase" ("facilityId", "supplierId", "supplierInvoiceNo", "invoiceDate", notes, "createdBy") VALUES (:fid, $1,$2,$3,$4,$5) RETURNING id`,
    [input.supplierId, input.supplierInvoiceNo.trim(), input.invoiceDate, input.notes?.trim() || null, actor],
  ))!.id;

  let taxable = 0;
  let gst = 0;
  for (const item of input.items) {
    const drug = await drugFor(tx, item);
    if (item.expiry <= today) throw badRequest(`${drug.name} batch ${item.batchNo} has already expired`);
    const gstPct = item.gstPct ?? drug.gstPct;
    const units = item.qty + item.freeQty;

    const existing = await tx.queryOne<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM "DrugBatch" WHERE "facilityId" = :fid AND "drugId" = $1 AND "batchNo" = $2 FOR UPDATE`, [
      drug.id, item.batchNo.trim(),
    ]);
    let batch: { id: string; drugId: string };
    if (existing) {
      if (existing.expiry !== item.expiry) throw conflict(`Batch ${item.batchNo} of ${drug.name} is already in stock with expiry ${existing.expiry}, not ${item.expiry}`);
      // The cost per unit becomes the average over what is on the shelf and what arrives (free units cost nothing).
      const cost = (existing.qty * (existing.purchaseRate ?? (item.purchaseRate * item.qty) / units) + item.qty * item.purchaseRate) / (existing.qty + units);
      await tx.execute('UPDATE "DrugBatch" SET mrp = $2, "purchaseRate" = $3 WHERE "facilityId" = :fid AND id = $1', [existing.id, item.mrp, Math.round(cost * 10000) / 10000]);
      batch = { id: existing.id, drugId: drug.id };
    } else {
      const effective = (item.purchaseRate * item.qty) / units;
      const created = await tx.queryOne<{ id: string }>(
        'INSERT INTO "DrugBatch" ("facilityId", "drugId", "batchNo", expiry, qty, mrp, "purchaseRate") VALUES (:fid, $1,$2,$3,0,$4,$5) RETURNING id',
        [drug.id, item.batchNo.trim(), item.expiry, item.mrp, Math.round(effective * 10000) / 10000],
      );
      batch = { id: created!.id, drugId: drug.id };
    }
    await moveStock(tx, batch, units, "purchase", actor, { refId: purchaseId });

    const lineTaxable = round2(item.qty * item.purchaseRate);
    const lineGst = round2((lineTaxable * gstPct) / 100);
    taxable += lineTaxable;
    gst += lineGst;
    await tx.execute(
      `INSERT INTO "PurchaseItem" ("facilityId", "purchaseId", "drugId", "batchId", "batchNo", expiry, qty, "freeQty", "purchaseRate", mrp, "gstPct", taxable, "gstAmount")
       VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [purchaseId, drug.id, batch.id, item.batchNo.trim(), item.expiry, item.qty, item.freeQty, item.purchaseRate, item.mrp, gstPct, lineTaxable, lineGst],
    );
  }

  const total = round2(taxable + gst);
  const paid = input.payment?.amount ?? 0;
  if (paid > total) throw badRequest("The payment is more than the invoice total");
  if (paid > 0 && !input.payment) throw badRequest("Say how it was paid");
  await tx.execute(
    'UPDATE "Purchase" SET taxable = $2, "gstTotal" = $3, total = $4, "amountPaid" = $5, "paymentMode" = $6, "paymentReference" = $7 WHERE "facilityId" = :fid AND id = $1',
    [purchaseId, round2(taxable), round2(gst), total, paid, paid > 0 ? input.payment!.mode : null, paid > 0 ? input.payment!.reference?.trim() || null : null],
  );
  const done = (await getPurchase(tx, purchaseId))!;
  await recordAudit(tx, actor, "Purchase Received", `${done.purchaseNo} from ${supplier.name} (invoice ${done.supplierInvoiceNo}): ${done.items.length} line(s), Rs ${done.total}`);
  return done;
}

/** Takes a wrongly entered purchase back out of stock. Only possible while none of its units has been sold or adjusted away. */
export async function cancelPurchase(tx: Queryable, id: string, reason: string, actor: string): Promise<PurchaseDto> {
  const purchase = await tx.queryOne<{ id: string; status: string; purchaseNo: string }>(
    'SELECT id, status, "purchaseNo" FROM "Purchase" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
    [id],
  );
  if (!purchase) throw notFound("Purchase");
  if (purchase.status === "cancelled") throw conflict("That purchase is already cancelled");
  if (reason.trim().length < 3) throw badRequest("Give a reason for cancelling the purchase");
  const items = await tx.query<{ drugId: string; batchId: string; qty: number; freeQty: number; drugName: string }>(
    'SELECT i."drugId", i."batchId", i.qty, i."freeQty", d.name AS "drugName" FROM "PurchaseItem" i JOIN "Drug" d ON d.id = i."drugId" WHERE i."facilityId" = :fid AND i."purchaseId" = $1',
    [id],
  );
  for (const item of items) {
    const batch = await tx.queryOne<{ qty: number }>('SELECT qty FROM "DrugBatch" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE', [item.batchId]);
    if (!batch || batch.qty < item.qty + item.freeQty) {
      throw conflict(`Some of ${item.drugName} from this purchase has already been sold or adjusted, so the purchase cannot be cancelled`);
    }
  }
  for (const item of items) await moveStock(tx, { id: item.batchId, drugId: item.drugId }, -(item.qty + item.freeQty), "purchase_cancel", actor, { refId: id, reason });
  await tx.execute(`UPDATE "Purchase" SET status = 'cancelled', "cancelReason" = $2, "cancelledBy" = $3, "cancelledAt" = now() WHERE "facilityId" = :fid AND id = $1`, [
    id, reason.trim(), actor,
  ]);
  await recordAudit(tx, actor, "Purchase Cancelled", `${purchase.purchaseNo}: ${reason.trim()}`);
  return (await getPurchase(tx, id))!;
}

/** Records a payment to the supplier against a purchase. */
export async function paySupplier(
  tx: Queryable,
  id: string,
  payment: { amount: number; mode: "cash" | "upi" | "card" | "bank" | "other"; reference?: string | undefined },
  actor: string,
): Promise<PurchaseDto> {
  const purchase = await tx.queryOne<{ status: string; total: number; amountPaid: number; purchaseNo: string }>(
    'SELECT status, total::float8 AS total, "amountPaid"::float8 AS "amountPaid", "purchaseNo" FROM "Purchase" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
    [id],
  );
  if (!purchase) throw notFound("Purchase");
  if (purchase.status !== "received") throw conflict("A cancelled purchase cannot be paid");
  if (round2(purchase.amountPaid + payment.amount) > purchase.total) throw badRequest(`That is more than the ${round2(purchase.total - purchase.amountPaid)} still due`);
  await tx.execute(
    'UPDATE "Purchase" SET "amountPaid" = "amountPaid" + $2, "paymentMode" = $3, "paymentReference" = COALESCE($4, "paymentReference") WHERE "facilityId" = :fid AND id = $1',
    [id, payment.amount, payment.mode, payment.reference?.trim() || null],
  );
  await recordAudit(tx, actor, "Supplier Payment", `${purchase.purchaseNo}: Rs ${payment.amount} (${payment.mode})`);
  return (await getPurchase(tx, id))!;
}

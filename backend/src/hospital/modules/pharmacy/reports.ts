import type { Queryable } from "../../db.js";
import { badRequest } from "../../shared/errors.js";
import { istEnd, istStart, round2, splitTax } from "./gst.js";
import { SELLABLE_STOCK, TODAY_IST } from "./stock.js";

/** Stock on the shelf, batch by batch, with what it is worth: at cost (where the purchase price is known) and at MRP. */
export async function stockReport(db: Queryable, options: { includeEmpty: boolean }) {
  const batches = await db.query<{
    batchId: string; drugId: string; name: string; unit: string; batchNo: string; expiry: string; qty: number; mrp: number; purchaseRate: number | null;
    costValue: number | null; mrpValue: number; state: "expired" | "near" | "ok";
  }>(
    `SELECT b.id AS "batchId", d.id AS "drugId", d.name, d.unit, b."batchNo", b.expiry, b.qty, b.mrp::float8 AS mrp, b."purchaseRate"::float8 AS "purchaseRate",
            (b.qty * b."purchaseRate")::float8 AS cost_value, (b.qty * b.mrp)::float8 AS mrp_value,
            CASE WHEN b.expiry < ${TODAY_IST} THEN 'expired' WHEN b.expiry <= ${TODAY_IST} + 90 THEN 'near' ELSE 'ok' END AS state
       FROM "DrugBatch" b JOIN "Drug" d ON d.id = b."drugId"
      WHERE b."facilityId" = :fid AND ($1::boolean OR b.qty > 0)
      ORDER BY d.name, b.expiry`,
    [options.includeEmpty],
  );
  const stocked = batches.filter((b) => b.qty > 0);
  const sum = (rows: typeof batches, pick: (b: (typeof batches)[number]) => number) => round2(rows.reduce((s, b) => s + pick(b), 0));
  return {
    batches,
    totals: {
      units: stocked.reduce((s, b) => s + b.qty, 0),
      costValue: sum(stocked.filter((b) => b.costValue !== null), (b) => b.costValue ?? 0),
      unknownCostUnits: stocked.filter((b) => b.purchaseRate === null).reduce((s, b) => s + b.qty, 0),
      mrpValue: sum(stocked, (b) => b.mrpValue),
      expiredUnits: stocked.filter((b) => b.state === "expired").reduce((s, b) => s + b.qty, 0),
      expiredValue: sum(stocked.filter((b) => b.state === "expired"), (b) => b.costValue ?? b.mrpValue),
      nearExpiryUnits: stocked.filter((b) => b.state === "near").reduce((s, b) => s + b.qty, 0),
    },
  };
}

export async function pharmacyDashboard(db: Queryable) {
  const today = `(s."soldAt" AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY_IST}`;
  const one = async <T>(sql: string) => (await db.queryOne<T>(sql))!;
  const counter = await one<{ n: number; total: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(total), 0)::float8 AS total FROM "PharmacySale" s WHERE s."facilityId" = :fid AND kind = 'counter' AND status = 'paid' AND ${today}`,
  );
  const dispensed = await one<{ n: number; total: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(total), 0)::float8 AS total FROM "PharmacySale" s WHERE s."facilityId" = :fid AND kind = 'encounter' AND ${today}`,
  );
  const waiting = await one<{ n: number }>('SELECT count(*)::int AS n FROM "Prescription" WHERE "facilityId" = :fid AND NOT dispensed');
  const low = await db.query<{ id: string; name: string; unit: string; reorderLevel: number; stock: number }>(
    `SELECT d.id, d.name, d.unit, d."reorderLevel", ${SELLABLE_STOCK} AS stock FROM "Drug" d
      WHERE d."facilityId" = :fid AND ${SELLABLE_STOCK} <= d."reorderLevel" ORDER BY ${SELLABLE_STOCK}, d.name LIMIT 20`,
  );
  const stock = await stockReport(db, { includeEmpty: false });
  const fast = await db.query<{ drugName: string; qty: number; total: number }>(
    `SELECT i."drugName", sum(i.qty)::int AS qty, sum(i."lineTotal")::float8 AS total
       FROM "PharmacySaleItem" i JOIN "PharmacySale" s ON s.id = i."saleId"
      WHERE s."facilityId" = :fid AND s.status = 'paid' AND s."soldAt" >= now() - interval '30 days' GROUP BY i."drugName" ORDER BY sum(i.qty) DESC LIMIT 8`,
  );
  const week = await db.query<{ day: string; total: number }>(
    `SELECT (s."soldAt" AT TIME ZONE 'Asia/Kolkata')::date::text AS day, sum(s.total)::float8 AS total
       FROM "PharmacySale" s WHERE s."facilityId" = :fid AND s.status = 'paid' AND s."soldAt" >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`,
  );
  const payable = await one<{ due: number }>(
    `SELECT COALESCE(sum(total - "amountPaid"), 0)::float8 AS due FROM "Purchase" WHERE "facilityId" = :fid AND status = 'received'`,
  );
  return {
    todayCounterSales: counter,
    todayDispensed: dispensed,
    prescriptionsWaiting: waiting.n,
    lowStock: low,
    stock: stock.totals,
    fastMoving: fast,
    lastSevenDays: week,
    owedToSuppliers: round2(payable.due),
  };
}

/** The period as instants: from the start of `from` to the end of `to`, Indian time. */
function period(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest("Give the period as from and to dates (YYYY-MM-DD)");
  if (to < from) throw badRequest("The end of the period is before its start");
  return { start: istStart(from).toISOString(), end: istEnd(to).toISOString() };
}

/**
 * Sale lines that count in a period: the invoices issued in it (unless they were cancelled before it ended) with a plus sign, and the invoices of an
 * earlier period that were cancelled in it (credit notes) with a minus sign. An invoice both issued and cancelled inside the period nets to nothing.
 */
const COUNTED = `
  SELECT i."drugName", i."hsnCode", i.qty, i."gstPct", i."lineTotal", i.taxable, i.tax, i.cost, s.kind, 1 AS sign
    FROM "PharmacySaleItem" i JOIN "PharmacySale" s ON s.id = i."saleId"
   WHERE s."facilityId" = :fid AND s."soldAt" >= $1::timestamptz AND s."soldAt" < $2::timestamptz AND (s.status = 'paid' OR s."cancelledAt" >= $2::timestamptz)
  UNION ALL
  SELECT i."drugName", i."hsnCode", i.qty, i."gstPct", i."lineTotal", i.taxable, i.tax, i.cost, s.kind, -1 AS sign
    FROM "PharmacySaleItem" i JOIN "PharmacySale" s ON s.id = i."saleId"
   WHERE s."facilityId" = :fid AND s.status = 'cancelled' AND s."cancelledAt" >= $1::timestamptz AND s."cancelledAt" < $2::timestamptz AND s."soldAt" < $1::timestamptz`;

/**
 * The figures for the GST return (GSTR-1) for pharmacy sales: supplies to consumers by tax rate (table 7), the HSN summary (table 12), credit notes, and the
 * documents issued (table 13). All sales are treated as within the state, so the tax splits equally into CGST and SGST. The purchase tax for the period is
 * listed beside it for reference. These are preparation figures: have the return checked before it is filed.
 */
export async function gstr1(db: Queryable, from: string, to: string) {
  const { start, end } = period(from, to);
  const b2c = await db.query<{ gstPct: number; taxable: number; tax: number; total: number }>(
    `SELECT "gstPct"::float8 AS "gstPct", sum(sign * taxable)::float8 AS taxable, sum(sign * tax)::float8 AS tax, sum(sign * "lineTotal")::float8 AS total
       FROM (${COUNTED}) c GROUP BY "gstPct" ORDER BY "gstPct"`,
    [start, end],
  );
  const hsn = await db.query<{ hsnCode: string; gstPct: number; qty: number; taxable: number; tax: number; total: number }>(
    `SELECT "hsnCode", "gstPct"::float8 AS "gstPct", sum(sign * qty)::int AS qty, sum(sign * taxable)::float8 AS taxable, sum(sign * tax)::float8 AS tax,
            sum(sign * "lineTotal")::float8 AS total
       FROM (${COUNTED}) c GROUP BY "hsnCode", "gstPct" ORDER BY "hsnCode", "gstPct"`,
    [start, end],
  );
  const creditNotes = await db.query<{ invoiceNo: string; soldAt: string; cancelledAt: string; taxable: number; tax: number; total: number }>(
    `SELECT "invoiceNo", "soldAt", "cancelledAt", taxable::float8 AS taxable, tax::float8 AS tax, total::float8 AS total FROM "PharmacySale"
      WHERE "facilityId" = :fid AND status = 'cancelled' AND "cancelledAt" >= $1::timestamptz AND "cancelledAt" < $2::timestamptz AND "soldAt" < $1::timestamptz
      ORDER BY "cancelledAt"`,
    [start, end],
  );
  const documents = (await db.queryOne<{ issued: number; cancelled: number; first: string | null; last: string | null }>(
    `SELECT count(*)::int AS issued, count(*) FILTER (WHERE status = 'cancelled' AND "cancelledAt" < $2::timestamptz)::int AS cancelled,
            (array_agg("invoiceNo" ORDER BY "soldAt"))[1] AS first, (array_agg("invoiceNo" ORDER BY "soldAt" DESC))[1] AS last
       FROM "PharmacySale" WHERE "facilityId" = :fid AND "soldAt" >= $1::timestamptz AND "soldAt" < $2::timestamptz`,
    [start, end],
  ))!;
  const inputTax = await db.query<{ gstPct: number; taxable: number; gst: number }>(
    `SELECT i."gstPct"::float8 AS "gstPct", sum(i.taxable)::float8 AS taxable, sum(i."gstAmount")::float8 AS gst
       FROM "PurchaseItem" i JOIN "Purchase" p ON p.id = i."purchaseId"
      WHERE p."facilityId" = :fid AND p.status = 'received' AND p."invoiceDate" >= $1::date AND p."invoiceDate" <= $2::date
      GROUP BY i."gstPct" ORDER BY i."gstPct"`,
    [from, to],
  );
  const split = <T extends { tax: number }>(r: T) => ({ ...r, ...splitTax(r.tax) });
  const taxable = round2(b2c.reduce((s, r) => s + r.taxable, 0));
  const tax = round2(b2c.reduce((s, r) => s + r.tax, 0));
  return {
    from,
    to,
    b2cByRate: b2c.map((r) => split({ ...r, taxable: round2(r.taxable), tax: round2(r.tax), total: round2(r.total) })),
    hsn: hsn.map((r) => split({ ...r, description: "Medicaments", uqc: "NOS", taxable: round2(r.taxable), tax: round2(r.tax), total: round2(r.total) })),
    creditNotes,
    documents,
    inputTax: inputTax.map((r) => ({ ...r, taxable: round2(r.taxable), gst: round2(r.gst) })),
    totals: { taxable, tax, ...splitTax(tax), total: round2(taxable + tax), inputTax: round2(inputTax.reduce((s, r) => s + r.gst, 0)) },
  };
}

/** What the pharmacy earned in a period: sales less what the medicines cost, by kind of sale and by medicine. */
export async function profitAndLoss(db: Queryable, from: string, to: string) {
  const { start, end } = period(from, to);
  const lines = await db.query<{ drugName: string; kind: "counter" | "encounter"; qty: number; taxable: number; tax: number; total: number; cost: number; unknownCost: number }>(
    `SELECT "drugName", kind, sum(sign * qty)::int AS qty, sum(sign * taxable)::float8 AS taxable, sum(sign * tax)::float8 AS tax, sum(sign * "lineTotal")::float8 AS total,
            COALESCE(sum(sign * cost), 0)::float8 AS cost, COALESCE(sum(sign * taxable) FILTER (WHERE cost IS NULL), 0)::float8 AS unknown_cost
       FROM (${COUNTED}) c GROUP BY "drugName", kind`,
    [start, end],
  );
  const purchases = (await db.queryOne<{ taxable: number; gst: number }>(
    `SELECT COALESCE(sum(taxable), 0)::float8 AS taxable, COALESCE(sum("gstTotal"), 0)::float8 AS gst FROM "Purchase"
      WHERE "facilityId" = :fid AND status = 'received' AND "invoiceDate" >= $1::date AND "invoiceDate" <= $2::date`,
    [from, to],
  ))!;
  const sum = (pick: (l: (typeof lines)[number]) => number, only?: "counter" | "encounter") =>
    round2(lines.filter((l) => !only || l.kind === only).reduce((s, l) => s + pick(l), 0));
  const byItem = new Map<string, { drugName: string; qty: number; revenue: number; cost: number; unknownCost: number }>();
  for (const l of lines) {
    const row = byItem.get(l.drugName) ?? { drugName: l.drugName, qty: 0, revenue: 0, cost: 0, unknownCost: 0 };
    row.qty += l.qty;
    row.revenue = round2(row.revenue + l.taxable);
    row.cost = round2(row.cost + l.cost);
    row.unknownCost = round2(row.unknownCost + l.unknownCost);
    byItem.set(l.drugName, row);
  }
  const revenue = sum((l) => l.taxable);
  const cost = sum((l) => l.cost);
  const unknown = sum((l) => l.unknownCost);
  // Revenue on lines whose cost is unknown is left out of the margin, so a missing cost never makes the profit look bigger than it is.
  const grossProfit = round2(revenue - unknown - cost);
  const costed = round2(revenue - unknown);
  return {
    from,
    to,
    revenue,
    taxCollected: sum((l) => l.tax),
    salesIncludingTax: sum((l) => l.total),
    revenueByKind: { counter: sum((l) => l.taxable, "counter"), encounter: sum((l) => l.taxable, "encounter") },
    costOfGoodsSold: cost,
    revenueWithoutKnownCost: unknown,
    grossProfit,
    marginPct: costed > 0 ? Math.round((grossProfit / costed) * 1000) / 10 : null,
    purchases: { taxable: round2(purchases.taxable), gst: round2(purchases.gst) },
    byItem: [...byItem.values()].map((i) => ({ ...i, profit: round2(i.revenue - i.unknownCost - i.cost) })).sort((a, b) => b.profit - a.profit),
  };
}

import type { Queryable } from "../../db.js";
import { conflict } from "../../shared/errors.js";

/**
 * Stock is held per batch (DrugBatch). Every change to a batch's quantity goes through `moveStock`, which writes the stock ledger line, so
 * a quantity never changes without a record of why. Selling takes from the batch that expires first (FEFO) and never from an expired one.
 */
export interface BatchRow {
  id: string;
  drugId: string;
  batchNo: string;
  expiry: string;
  qty: number;
  mrp: number;
  purchaseRate: number | null;
  receivedAt: string;
}

export const BATCH_COLUMNS = 'id, "drugId", "batchNo", expiry, qty, mrp::float8 AS mrp, "purchaseRate"::float8 AS "purchaseRate", "receivedAt"';

export type LedgerKind = "opening" | "purchase" | "purchase_cancel" | "sale" | "dispense" | "sale_cancel" | "adjustment";

/** Changes a batch's quantity by `delta` and records it. Refuses to go below zero. */
export async function moveStock(
  tx: Queryable,
  batch: { id: string; drugId: string },
  delta: number,
  kind: LedgerKind,
  by: string,
  options: { refId?: string | null; reason?: string | null } = {},
): Promise<void> {
  const updated = await tx.execute('UPDATE "DrugBatch" SET qty = qty + $2 WHERE "facilityId" = :fid AND id = $1 AND qty + $2 >= 0', [batch.id, delta]);
  if (updated === 0) throw conflict("There is not enough stock in that batch");
  await tx.execute('INSERT INTO "StockLedger" ("facilityId", "batchId", "drugId", delta, kind, "refId", reason, by) VALUES (:fid, $1,$2,$3,$4,$5,$6,$7)', [
    batch.id, batch.drugId, delta, kind, options.refId ?? null, options.reason ?? null, by,
  ]);
}

export interface Allocation {
  batch: BatchRow;
  qty: number;
}

/** Today's date in India, which is what "expired" is measured against. */
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * Chooses the batches to sell `qty` units of a medicine from, earliest expiry first, locking them. A specific batch can be asked for. An expired
 * batch is never used. Throws, naming how many units are available, when there is not enough.
 */
export async function allocateStock(tx: Queryable, drugId: string, drugName: string, qty: number, batchId?: string): Promise<Allocation[]> {
  const batches = await tx.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM "DrugBatch"
      WHERE "facilityId" = :fid AND "drugId" = $1 AND qty > 0 AND expiry >= ${TODAY} AND ($2::text IS NULL OR id = $2)
      ORDER BY expiry, "receivedAt" FOR UPDATE`,
    [drugId, batchId ?? null],
  );
  const available = batches.reduce((sum, b) => sum + b.qty, 0);
  if (available < qty) {
    throw conflict(available === 0 ? `${drugName} is out of stock (expired batches are not sold)` : `Only ${available} of ${drugName} in stock`);
  }
  const chosen: Allocation[] = [];
  let left = qty;
  for (const batch of batches) {
    if (left === 0) break;
    const take = Math.min(left, batch.qty);
    chosen.push({ batch, qty: take });
    left -= take;
  }
  return chosen;
}

/** Units of the medicine `d` that can be sold today (not expired). */
export const SELLABLE_STOCK = `COALESCE((SELECT sum(qty) FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.expiry >= ${TODAY}), 0)::int`;
export const TODAY_IST = TODAY;

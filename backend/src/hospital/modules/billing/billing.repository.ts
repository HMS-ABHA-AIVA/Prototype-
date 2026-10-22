import type { Queryable } from "../../db.js";

export interface BillRow {
  id: string;
  billNo: string;
  encounterId: string;
  patientId: string;
  status: "draft" | "finalized" | "paid" | "void";
  /** 'opd_fee' = the consultation fee collected at OPD billing before the visit joins the queue; 'final' = everything else. */
  kind: "opd_fee" | "final";
  paymentMode: "cash" | "upi" | "card" | "other" | null;
  paidAt: string | null;
  /** The OPD billing payment (receipt) this fee was collected in, if it was. */
  paymentId: string | null;
  /** For an OPD fee: the doctor's fee it was raised at, before any panel rate or discount. */
  standardFee: number | null;
  /** The panel (CGHS, DGHS ...) a final bill was priced under, as it was at the time, and the patient's card number. */
  panelId: string | null;
  panelName: string | null;
  beneficiaryId: string | null;
  /** A discount given on a final bill: percent or amount, and why. */
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  discountReason: string | null;
  createdAt: string;
}

export interface BillItemRow {
  id: string;
  billId: string;
  label: string;
  qty: number;
  rate: number;
  gstPct: number;
  isDiscount: boolean;
}
export interface NewBillItem {
  label: string;
  qty: number;
  rate: number;
  gstPct: number;
  isDiscount?: boolean;
}

export const BILL_COLUMNS = `id, "billNo", "encounterId", "patientId", status, kind, "paymentMode", "paidAt", "paymentId", "standardFee"::float8 AS "standardFee",
  "panelId", "panelName", "beneficiaryId", "discountType", "discountValue"::float8 AS "discountValue", "discountReason", "createdAt"`;
const ITEM_COLUMNS = 'id, "billId", label, qty, rate::float8 AS rate, "gstPct"::float8 AS "gstPct", "isDiscount"';

export const findBillByEncounter = (db: Queryable, encounterId: string, kind: BillRow["kind"] = "final") =>
  db.queryOne<BillRow>(`SELECT ${BILL_COLUMNS} FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = $2`, [encounterId, kind]);

export const findBill = (db: Queryable, id: string) => db.queryOne<BillRow>(`SELECT ${BILL_COLUMNS} FROM "Bill" WHERE "facilityId" = :fid AND id = $1`, [id]);

export const lockBill = (db: Queryable, id: string) => db.queryOne<BillRow>(`SELECT ${BILL_COLUMNS} FROM "Bill" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`, [id]);

export const listBills = (db: Queryable, patientId: string | null, limit: number) =>
  db.query<BillRow>(`SELECT ${BILL_COLUMNS} FROM "Bill" WHERE "facilityId" = :fid AND ($1::text IS NULL OR "patientId" = $1) ORDER BY "createdAt" DESC LIMIT $2`, [
    patientId,
    limit,
  ]);

export const insertBill = (
  db: Queryable,
  encounterId: string,
  patientId: string,
  kind: BillRow["kind"] = "final",
  standardFee: number | null = null,
  panel: { id: string; name: string; beneficiaryId: string | null } | null = null,
) =>
  db.queryOne<BillRow>(
    `INSERT INTO "Bill" ("facilityId", "encounterId", "patientId", kind, "standardFee", "panelId", "panelName", "beneficiaryId")
     VALUES (:fid, $1,$2,$3,$4,$5,$6,$7) RETURNING ${BILL_COLUMNS}`,
    [encounterId, patientId, kind, standardFee, panel?.id ?? null, panel?.name ?? null, panel?.beneficiaryId ?? null],
  );

/** Rewrites a bill's lines (used when OPD billing applies a panel rate or a discount). */
export async function replaceBillItems(db: Queryable, billId: string, items: NewBillItem[]) {
  await db.execute('DELETE FROM "BillItem" WHERE "facilityId" = :fid AND "billId" = $1', [billId]);
  for (const item of items) await insertBillItem(db, billId, item);
}

export const insertBillItem = (db: Queryable, billId: string, item: NewBillItem) =>
  db.execute('INSERT INTO "BillItem" ("facilityId", "billId", label, qty, rate, "gstPct", "isDiscount") VALUES (:fid, $1,$2,$3,$4,$5,$6)', [
    billId, item.label, item.qty, item.rate, item.gstPct, item.isDiscount ?? false,
  ]);

export const listBillItems = (db: Queryable, billId: string) =>
  db.query<BillItemRow>(`SELECT ${ITEM_COLUMNS} FROM "BillItem" WHERE "facilityId" = :fid AND "billId" = $1 ORDER BY "lineNo"`, [billId]);

export const listBillItemsForMany = (db: Queryable, billIds: string[]) =>
  db.query<BillItemRow>(`SELECT ${ITEM_COLUMNS} FROM "BillItem" WHERE "facilityId" = :fid AND "billId" = ANY($1::text[]) ORDER BY "lineNo"`, [billIds]);

export const encounterTypes = (db: Queryable, encounterIds: string[]) =>
  db.query<{ id: string; type: "OPD" | "IPD" | "ER" }>('SELECT id, type FROM "Encounter" WHERE "facilityId" = :fid AND id = ANY($1::text[])', [encounterIds]);

export const payBill = (db: Queryable, id: string, mode: NonNullable<BillRow["paymentMode"]>, paymentId: string | null = null) =>
  db.execute(`UPDATE "Bill" SET status = 'paid', "paymentMode" = $2, "paidAt" = now(), "paymentId" = $3 WHERE "facilityId" = :fid AND id = $1`, [id, mode, paymentId]);

export const setBillStatus = (db: Queryable, id: string, status: BillRow["status"]) =>
  db.execute('UPDATE "Bill" SET status = $2 WHERE "facilityId" = :fid AND id = $1', [id, status]);

export const setBillDiscount = (db: Queryable, id: string, d: { type: "percent" | "amount"; value: number; reason: string } | null) =>
  db.execute('UPDATE "Bill" SET "discountType" = $2, "discountValue" = $3, "discountReason" = $4 WHERE "facilityId" = :fid AND id = $1', [
    id, d?.type ?? null, d?.value ?? null, d?.reason ?? null,
  ]);

export const setBillPanel = (db: Queryable, id: string, panel: { id: string; name: string; beneficiaryId: string | null } | null) =>
  db.execute('UPDATE "Bill" SET "panelId" = $2, "panelName" = $3, "beneficiaryId" = $4 WHERE "facilityId" = :fid AND id = $1', [
    id, panel?.id ?? null, panel?.name ?? null, panel?.beneficiaryId ?? null,
  ]);

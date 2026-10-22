import { Router, type Request } from "express";
import { z } from "zod";
import type { HospitalContext } from "../../context.js";
import type { Database, Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { BILL_COLUMNS, listBillItems, lockBill, payBill, replaceBillItems, setBillStatus, type BillRow } from "../billing/billing.repository.js";
import { toBillDto, toBillDtos, type BillDto } from "../billing/billing.service.js";
import { issueToken, lockEncounter, nextTokenNo, setStatus } from "../encounters/encounters.repository.js";
import { openOpdVisit, toEncounterDetail, toEncounterDetails } from "../encounters/encounters.service.js";
import { findPanel, toPricing } from "../panels/panels.js";
import { birthYearOf } from "../patients/patients.repository.js";
import { findStaff } from "../staff/staff.js";
import { priceConsultations, round2, type ConsultationToPrice, type DiscountInput } from "./opd-pricing.js";

/**
 * OPD billing: registration, then billing, then the queue.
 *
 * A patient may see several doctors in one visit (one per speciality / department). Each consultation is its own OPD visit with its own
 * doctor, fee bill, token and appointment slip. Billing one patient produces one OPD INVOICE (which is also the receipt): it covers the
 * chosen doctors' fees at the standard rates or a panel's special rates (CGHS, DGHS ...), less any discount the billing counter gives
 * (with a reason), and records how it was paid and by whom. Paying issues each doctor's token and puts the patient in each queue.
 * Invoices can be looked up and reprinted later, and cancelled with a refund (before the consultation has started).
 *
 * A patient can also be registered for several doctors without paying yet (the front desk); they wait in the "awaiting payment" list.
 */
export type PaymentMode = "cash" | "upi" | "card" | "other";
const MODES = ["cash", "upi", "card", "other"] as const;

/** The Indian calendar day, which is what a hospital counter means by "today". */
const TODAY_IST = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

const BILL_SELECT = `b.id, b."billNo", b."encounterId", b."patientId", b.status, b.kind, b."paymentMode", b."paidAt", b."paymentId",
  b."standardFee"::float8 AS "standardFee", b."panelId", b."panelName", b."beneficiaryId", b."discountType", b."discountValue"::float8 AS "discountValue",
  b."discountReason", b."createdAt"`;

export interface AwaitingOpdVisit {
  billId: string;
  billNo: string;
  encounterId: string;
  patientId: string;
  patientName: string;
  mrn: string;
  department: string;
  doctorId: string | null;
  doctorName: string | null;
  createdAt: string;
  items: BillDto["items"];
  total: number;
}

/** One doctor's appointment slip: what the patient takes to that doctor's consultation room. */
export interface AppointmentSlip {
  /** The consultation-fee bill number, which is this slip's own number. */
  slipNo: string;
  receiptNo: string;
  billId: string;
  encounterId: string;
  patientId: string;
  patientName: string;
  mrn: string;
  age: number | null;
  gender: string | null;
  department: string;
  doctorName: string | null;
  doctorHprId: string | null;
  tokenNo: number | null;
  /** What this consultation cost after any panel rate and discount. */
  fee: number;
  paymentMode: PaymentMode | null;
  collectedByName: string;
  collectedAt: string;
}

export interface InvoiceLine {
  slipNo: string;
  label: string;
  amount: number;
}

export interface OpdInvoice {
  id: string;
  /** The invoice number, which is also the receipt number (OPD-1005 ...). */
  invoiceNo: string;
  status: "paid" | "cancelled";
  patientId: string;
  patientName: string;
  mrn: string;
  patientAge: number | null;
  patientGender: string | null;
  panelId: string | null;
  panelCode: string | null;
  panelName: string | null;
  beneficiaryId: string | null;
  lines: InvoiceLine[];
  /** At the rates charged (standard or panel), before any discount. */
  grossAmount: number;
  discountAmount: number;
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  discountReason: string | null;
  /** What the patient paid (after discount). */
  amount: number;
  mode: PaymentMode;
  reference: string | null;
  /** Cash handed over (cash payments only, when it was entered). */
  amountReceived: number | null;
  /** Change to give back for a cash payment. */
  change: number | null;
  collectedByName: string;
  collectedAt: string;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  refundAmount: number | null;
  refundMode: PaymentMode | null;
  refundReference: string | null;
  slips: AppointmentSlip[];
}

// ---- reading -----------------------------------------------------------------------------------

export async function listAwaitingOpd(db: Queryable): Promise<AwaitingOpdVisit[]> {
  type Row = BillRow & { patientName: string; mrn: string; department: string; doctorId: string | null; doctorName: string | null };
  const rows = await db.query<Row>(
    `SELECT ${BILL_SELECT}, p.name AS patient_name, p.mrn, e.department, e."doctorId", s.name AS doctor_name
       FROM "Bill" b
       JOIN "Encounter" e ON e.id = b."encounterId"
       JOIN "Patient" p ON p.id = e."patientId"
       LEFT JOIN "Staff" s ON s.id = e."doctorId"
      WHERE b."facilityId" = :fid AND b.kind = 'opd_fee' AND b.status = 'draft' AND e.status = 'awaiting_payment'
      ORDER BY p.name, b."createdAt"`,
  );
  const bills = await toBillDtos(db, rows);
  return rows.map((r, i) => ({
    billId: r.id, billNo: r.billNo, encounterId: r.encounterId, patientId: r.patientId, patientName: r.patientName, mrn: r.mrn,
    department: r.department, doctorId: r.doctorId, doctorName: r.doctorName, createdAt: r.createdAt, items: bills[i]!.items, total: bills[i]!.total,
  }));
}

async function invoicesByIds(db: Queryable, ids: string[]): Promise<OpdInvoice[]> {
  if (ids.length === 0) return [];
  type PayRow = {
    id: string; invoiceNo: string; status: "paid" | "cancelled"; patientId: string; patientName: string; mrn: string; yearOfBirth: number | null; gender: string | null;
    panelId: string | null; panelCode: string | null; panelName: string | null; beneficiaryId: string | null;
    grossAmount: number | null; discountAmount: number; discountType: "percent" | "amount" | null; discountValue: number | null; discountReason: string | null;
    amount: number; mode: PaymentMode; reference: string | null; amountReceived: number | null; collectedByName: string; collectedAt: string;
    cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null;
    refundAmount: number | null; refundMode: PaymentMode | null; refundReference: string | null;
  };
  const pays = await db.query<PayRow>(
    `SELECT pay.id, pay."receiptNo" AS "invoiceNo", pay.status, pay."patientId", p.name AS patient_name, p.mrn, ${birthYearOf("p")} AS "yearOfBirth", p.gender,
            pay."panelId", pn.code AS panel_code, pay."panelName", pay."beneficiaryId",
            pay."grossAmount"::float8 AS "grossAmount", pay."discountAmount"::float8 AS "discountAmount", pay."discountType",
            pay."discountValue"::float8 AS "discountValue", pay."discountReason",
            pay.amount::float8 AS amount, pay.mode, pay.reference, pay."amountReceived"::float8 AS "amountReceived", pay."collectedByName", pay."collectedAt",
            pay."cancelledAt", pay."cancelledByName", pay."cancelReason",
            pay."refundAmount"::float8 AS "refundAmount", pay."refundMode", pay."refundReference"
       FROM "OpdPayment" pay
       JOIN "Patient" p ON p.id = pay."patientId"
       LEFT JOIN "Panel" pn ON pn.id = pay."panelId"
      WHERE pay."facilityId" = :fid AND pay.id = ANY($1::text[])
      ORDER BY pay."collectedAt" DESC, pay."receiptNo" DESC`,
    [ids],
  );

  type BillRowEx = BillRow & { tokenNo: number | null; department: string; doctorName: string | null; doctorHprId: string | null };
  const billRows = await db.query<BillRowEx>(
    `SELECT ${BILL_SELECT}, e."tokenNo", e.department, st.name AS doctor_name, st."hprId" AS doctor_hpr_id
       FROM "Bill" b
       JOIN "Encounter" e ON e.id = b."encounterId"
       LEFT JOIN "Staff" st ON st.id = e."doctorId"
      WHERE b."facilityId" = :fid AND b."paymentId" = ANY($1::text[])
      ORDER BY b."createdAt", e."createdAt"`,
    [ids],
  );
  const billDtos = await toBillDtos(db, billRows);
  const year = new Date().getFullYear();

  return pays.map((pay) => {
    const mine = billRows.map((r, i) => ({ row: r, dto: billDtos[i]! })).filter((x) => x.row.paymentId === pay.id);
    const slips: AppointmentSlip[] = mine.map(({ row, dto }) => ({
      slipNo: row.billNo, receiptNo: pay.invoiceNo, billId: row.id, encounterId: row.encounterId, patientId: pay.patientId, patientName: pay.patientName, mrn: pay.mrn,
      age: pay.yearOfBirth ? year - pay.yearOfBirth : null, gender: pay.gender, department: row.department, doctorName: row.doctorName, doctorHprId: row.doctorHprId,
      tokenNo: row.tokenNo, fee: dto.total, paymentMode: row.paymentMode, collectedByName: pay.collectedByName, collectedAt: pay.collectedAt,
    }));
    const lines: InvoiceLine[] = mine.flatMap(({ row, dto }) => dto.items.map((item) => ({ slipNo: row.billNo, label: item.label, amount: item.amount })));
    return {
      id: pay.id, invoiceNo: pay.invoiceNo, status: pay.status, patientId: pay.patientId, patientName: pay.patientName, mrn: pay.mrn,
      patientAge: pay.yearOfBirth ? year - pay.yearOfBirth : null, patientGender: pay.gender,
      panelId: pay.panelId, panelCode: pay.panelCode, panelName: pay.panelName, beneficiaryId: pay.beneficiaryId,
      lines, grossAmount: pay.grossAmount ?? pay.amount, discountAmount: pay.discountAmount, discountType: pay.discountType, discountValue: pay.discountValue,
      discountReason: pay.discountReason, amount: pay.amount, mode: pay.mode, reference: pay.reference, amountReceived: pay.amountReceived,
      change: pay.mode === "cash" && pay.amountReceived != null ? round2(pay.amountReceived - pay.amount) : null,
      collectedByName: pay.collectedByName, collectedAt: pay.collectedAt,
      cancelledAt: pay.cancelledAt, cancelledByName: pay.cancelledByName, cancelReason: pay.cancelReason,
      refundAmount: pay.refundAmount, refundMode: pay.refundMode, refundReference: pay.refundReference, slips,
    };
  });
}

export const getInvoice = async (db: Queryable, id: string): Promise<OpdInvoice> => {
  const found = (await invoicesByIds(db, [id]))[0];
  if (!found) throw notFound("Invoice");
  return found;
};

export interface InvoiceFilter {
  from: string | null;
  to: string | null;
  status: "all" | "paid" | "cancelled";
  search: string | null;
  limit: number;
}

/** OPD invoices raised between two Indian calendar days (today by default), newest first, with totals. */
export async function listInvoices(db: Queryable, f: InvoiceFilter) {
  const like = f.search?.trim() ? `%${f.search.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const ids = (
    await db.query<{ id: string }>(
      `SELECT pay.id
         FROM "OpdPayment" pay JOIN "Patient" p ON p.id = pay."patientId"
        WHERE pay."facilityId" = :fid
          AND (pay."collectedAt" AT TIME ZONE 'Asia/Kolkata')::date BETWEEN COALESCE($1::date, ${TODAY_IST}) AND COALESCE($2::date, $1::date, ${TODAY_IST})
          AND ($3::text = 'all' OR pay.status = $3)
          AND ($4::text IS NULL OR pay."receiptNo" ILIKE $4 OR p.name ILIKE $4 OR p.mrn ILIKE $4 OR p.phone ILIKE $4)
        ORDER BY pay."collectedAt" DESC, pay."receiptNo" DESC
        LIMIT $5`,
      [f.from, f.to, f.status, like, f.limit],
    )
  ).map((r) => r.id);
  const invoices = await invoicesByIds(db, ids);

  const collectedByMode: Record<PaymentMode, number> = { cash: 0, upi: 0, card: 0, other: 0 };
  const refundedByMode: Record<PaymentMode, number> = { cash: 0, upi: 0, card: 0, other: 0 };
  let collected = 0;
  let refunded = 0;
  let discounts = 0;
  for (const inv of invoices) {
    collected += inv.amount;
    collectedByMode[inv.mode] += inv.amount;
    if (inv.status === "paid") discounts += inv.discountAmount;
    if (inv.refundAmount) {
      refunded += inv.refundAmount;
      refundedByMode[inv.refundMode ?? inv.mode] += inv.refundAmount;
    }
  }
  const netByMode = Object.fromEntries(MODES.map((m) => [m, round2(collectedByMode[m] - refundedByMode[m])])) as Record<PaymentMode, number>;
  const from = f.from ?? (await db.queryOne<{ d: string }>(`SELECT to_char(${TODAY_IST}, 'YYYY-MM-DD') AS d`))!.d;
  return {
    from,
    to: f.to ?? from,
    invoices,
    totals: {
      count: invoices.length,
      paidCount: invoices.filter((i) => i.status === "paid").length,
      cancelledCount: invoices.filter((i) => i.status === "cancelled").length,
      collected: round2(collected),
      refunded: round2(refunded),
      net: round2(collected - refunded),
      discounts: round2(discounts),
      byMode: netByMode,
    },
  };
}

// ---- pricing preview -----------------------------------------------------------------------------

export interface PricingInput {
  panelId?: string | null | undefined;
  beneficiaryId?: string | null | undefined;
  discount?: DiscountInput | null | undefined;
}

async function standardFeeOf(db: Queryable, bill: BillRow): Promise<number> {
  return bill.standardFee ?? (await listBillItems(db, bill.id))[0]?.rate ?? 0;
}

/** What the invoice would come to, line by line, without saving anything. */
export async function quote(db: Queryable, input: PricingInput & { consultations?: { department: string; doctorId: string }[] | undefined; billIds?: string[] | undefined }) {
  const items: ConsultationToPrice[] = [];
  if (input.billIds?.length) {
    for (const id of input.billIds) {
      const bill = await lockBill(db, id);
      if (!bill || bill.kind !== "opd_fee") throw notFound("Consultation fee");
      const enc = await db.queryOne<{ department: string; doctorId: string | null }>('SELECT department, "doctorId" FROM "Encounter" WHERE "facilityId" = :fid AND id = $1', [
        bill.encounterId,
      ]);
      const doctor = enc?.doctorId ? await findStaff(db, enc.doctorId) : null;
      items.push({ department: enc?.department ?? "", doctorName: doctor?.name ?? "Doctor", standardFee: await standardFeeOf(db, bill) });
    }
  }
  for (const c of input.consultations ?? []) {
    const doctor = await findStaff(db, c.doctorId);
    if (!doctor || doctor.role !== "doctor") throw badRequest("Choose a doctor for each speciality");
    items.push({ department: c.department, doctorName: doctor.name, standardFee: doctor.opdFee });
  }
  if (items.length === 0) throw badRequest("Choose at least one doctor");

  const panel = input.panelId ? await findPanel(db, input.panelId) : null;
  if (input.panelId && (!panel || !panel.active)) throw badRequest("That panel is not available");
  const priced = priceConsultations(items, panel ? toPricing(panel) : null, input.discount ?? null);
  return {
    panel: panel ? { id: panel.id, code: panel.code, name: panel.name, requiresBeneficiaryId: panel.requiresBeneficiaryId, hasSpecialRates: panel.hasSpecialRates } : null,
    ...priced,
  };
}

// ---- registering several consultations (without paying yet) -----------------------------------------

export interface ConsultationRequest {
  department: string;
  doctorId: string;
}

/** Opens one OPD consultation per requested doctor (all awaiting payment, each with its own fee bill). All or none. */
export async function registerConsultations(db: Database, patientId: string, consultations: ConsultationRequest[], actor: string) {
  const departments = consultations.map((c) => c.department.trim().toLowerCase());
  if (new Set(departments).size !== departments.length) throw badRequest("Choose each speciality / department only once per registration");
  return db.transaction(async (tx) => {
    const rows = [];
    for (const c of consultations) rows.push(await openOpdVisit(tx, { patientId, department: c.department, doctorId: c.doctorId }, actor));
    return toEncounterDetails(tx, rows);
  });
}

// ---- taking payment ------------------------------------------------------------------------------------

/** Where a fee bill and its visit stand, locked, or a clear refusal when this is not an unpaid OPD fee. */
async function lockUnpaidFee(tx: Queryable, billId: string) {
  const bill = await lockBill(tx, billId);
  if (!bill) throw notFound("Bill");
  if (bill.kind !== "opd_fee") throw conflict(`${bill.billNo} is not an OPD consultation fee`);
  if (bill.status !== "draft") throw conflict(`${bill.billNo} is already ${bill.status}`);
  const encounter = await lockEncounter(tx, bill.encounterId);
  if (!encounter || encounter.status !== "awaiting_payment") throw conflict("This visit is no longer waiting for payment");
  return { bill, encounter };
}

export interface PaymentInput {
  mode: PaymentMode;
  /** UPI transaction id, card slip / last digits, cheque number ... Required for UPI and card. */
  reference?: string | null | undefined;
  /** Cash handed over, so the change can be worked out. Cash only. */
  amountReceived?: number | null | undefined;
}
export interface Collector {
  id: string | null;
  name: string;
}

/**
 * Prices the chosen consultation fees (standard rates, or a panel's), applies any discount, takes the payment and issues each doctor's next
 * token. Everything happens together or not at all. `canDiscount` says whether the person at the counter may give a discount.
 */
async function settleFees(tx: Queryable, billIds: string[], pricing: PricingInput, payment: PaymentInput, collector: Collector, canDiscount: boolean) {
  if (new Set(billIds).size !== billIds.length) throw badRequest("The same consultation fee was listed twice");
  // Lock in a fixed order so two counters paying overlapping fees cannot deadlock each other.
  const locked = new Map<string, Awaited<ReturnType<typeof lockUnpaidFee>>>();
  for (const id of [...billIds].sort()) locked.set(id, await lockUnpaidFee(tx, id));
  const fees = billIds.map((id) => locked.get(id)!);
  if (new Set(fees.map((f) => f.bill.patientId)).size > 1) throw badRequest("One payment can only cover one patient's consultations");

  const discount = pricing.discount ?? null;
  if (discount) {
    if (!canDiscount) throw forbidden("Only the billing counter or an administrator can give a discount");
    if ((discount.reason ?? "").trim().length < 3) throw badRequest("Give a reason for the discount");
  }
  const panel = pricing.panelId ? await findPanel(tx, pricing.panelId) : null;
  if (pricing.panelId && (!panel || !panel.active)) throw badRequest("That panel is not available");
  const beneficiaryId = pricing.beneficiaryId?.trim() || null;
  if (panel?.requiresBeneficiaryId && (!beneficiaryId || beneficiaryId.length < 3)) throw badRequest(`Enter the ${panel.code} beneficiary / card number`);

  const doctors = await Promise.all(fees.map((f) => (f.encounter.doctorId ? findStaff(tx, f.encounter.doctorId) : null)));
  const priced = priceConsultations(
    await Promise.all(fees.map(async (f, i) => ({ department: f.encounter.department, doctorName: doctors[i]?.name ?? "Doctor", standardFee: await standardFeeOf(tx, f.bill) }))),
    panel ? toPricing(panel) : null,
    discount,
  );
  if (panel || discount) {
    for (let i = 0; i < fees.length; i++) {
      const c = priced.consultations[i]!;
      await replaceBillItems(tx, fees[i]!.bill.id, [
        { label: c.label, qty: 1, rate: c.rate, gstPct: 0 },
        ...(c.discount > 0 ? [{ label: c.discountLabel!, qty: 1, rate: -c.discount, gstPct: 0 }] : []),
      ]);
    }
  }

  const bills = await toBillDtos(tx, fees.map((f) => f.bill));
  const amount = round2(bills.reduce((sum, b) => sum + b.total, 0));
  const reference = payment.reference?.trim() || null;
  if ((payment.mode === "upi" || payment.mode === "card") && (!reference || reference.length < 3)) {
    throw badRequest(`Enter the ${payment.mode === "upi" ? "UPI transaction id" : "card slip or last digits"} for this payment`);
  }
  const received = payment.mode === "cash" ? payment.amountReceived ?? null : null;
  if (received != null && received < amount) throw badRequest(`The cash received (Rs ${received}) is less than the amount due (Rs ${amount})`);

  const row = (await tx.queryOne<{ id: string; receiptNo: string }>(
    `INSERT INTO "OpdPayment" ("facilityId", "patientId", mode, reference, amount, "amountReceived", "collectedById", "collectedByName",
                              "panelId", "panelName", "beneficiaryId", "grossAmount", "discountAmount", "discountType", "discountValue", "discountReason")
     VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, "receiptNo"`,
    [
      fees[0]!.bill.patientId, payment.mode, reference, amount, received, collector.id, collector.name,
      panel?.id ?? null, panel?.name ?? null, beneficiaryId, panel || discount ? priced.gross : amount, discount ? priced.discount : 0,
      discount?.type ?? null, discount?.value ?? null, discount?.reason?.trim() ?? null,
    ],
  ))!;

  for (const { bill, encounter } of fees) {
    const tokenNo = await nextTokenNo(tx, encounter.department);
    await payBill(tx, bill.id, payment.mode, row.id);
    await issueToken(tx, encounter.id, tokenNo);
    const fee = bills.find((b) => b.id === bill.id)!;
    await recordAudit(tx, collector.name, "OPD Fee Collected", `${bill.billNo} Rs ${fee.total.toFixed(2)} (${payment.mode}), token #${tokenNo} - ${encounter.department}, receipt ${row.receiptNo}`);
  }
  await recordAudit(
    tx,
    collector.name,
    "OPD Payment Received",
    `${row.receiptNo} Rs ${amount.toFixed(2)} (${payment.mode}${reference ? `, ref ${reference}` : ""}) for ${fees.length} consultation(s)${
      panel ? `, panel ${panel.code}${beneficiaryId ? ` ${beneficiaryId}` : ""}` : ""
    }${discount ? `, discount Rs ${priced.discount.toFixed(2)} (${discount.reason!.trim()})` : ""}`,
  );

  const encounters = await toEncounterDetails(tx, (await Promise.all(fees.map((f) => lockEncounter(tx, f.encounter.id)))).filter((e): e is NonNullable<typeof e> => !!e));
  const paidBills = await Promise.all(
    fees.map(async (f) => toBillDto(tx, (await tx.queryOne<BillRow>(`SELECT ${BILL_COLUMNS} FROM "Bill" WHERE "facilityId" = :fid AND id = $1`, [f.bill.id]))!)),
  );
  return { invoice: await getInvoice(tx, row.id), encounters, bills: paidBills };
}

export interface CollectInput extends PricingInput, PaymentInput {
  /** The consultation fees being paid in this one payment (one bill per doctor). They must all be for the same patient. */
  billIds: string[];
}

/** Takes one payment for one or more of a patient's registered consultation fees (see `registerConsultations`). */
export const collectOpdPayment = (db: Database, input: CollectInput, collector: Collector, canDiscount: boolean) =>
  db.transaction((tx) => settleFees(tx, input.billIds, input, input, collector, canDiscount));

export interface NewInvoiceInput extends PricingInput, PaymentInput {
  patientId: string;
  consultations: ConsultationRequest[];
}

/** OPD billing in one step: register the patient for the chosen doctors, price it, take the payment, issue tokens and slips. */
export async function createInvoice(db: Database, input: NewInvoiceInput, collector: Collector, canDiscount: boolean) {
  const departments = input.consultations.map((c) => c.department.trim().toLowerCase());
  if (new Set(departments).size !== departments.length) throw badRequest("Choose each speciality / department only once per invoice");
  return db.transaction(async (tx) => {
    const billIds: string[] = [];
    for (const c of input.consultations) {
      const visit = await openOpdVisit(tx, { patientId: input.patientId, department: c.department, doctorId: c.doctorId }, collector.name);
      const bill = await tx.queryOne<{ id: string }>(`SELECT id FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'opd_fee'`, [visit.id]);
      billIds.push(bill!.id);
    }
    return settleFees(tx, billIds, input, input, collector, canDiscount);
  });
}

// ---- cancelling an invoice, with a refund ------------------------------------------------------------

export interface CancelInput {
  reason: string;
  /** Defaults to everything that was paid. Less than that keeps a cancellation charge. */
  refundAmount?: number | null | undefined;
  /** Defaults to the mode the invoice was paid in. */
  refundMode?: PaymentMode | null | undefined;
  refundReference?: string | null | undefined;
}

/**
 * Cancels a paid OPD invoice and records the refund (for a special situation: wrong doctor, patient leaves, duplicate billing ...).
 * Only while every consultation on it is still waiting: once a doctor has started seeing the patient it cannot be undone here.
 * The fee bills are voided and the visits cancelled (their tokens are no longer used).
 */
export async function cancelInvoice(db: Database, invoiceId: string, input: CancelInput, user: Collector) {
  return db.transaction(async (tx) => {
    const pay = await tx.queryOne<{ id: string; receiptNo: string; status: string; amount: number; mode: PaymentMode }>(
      'SELECT id, "receiptNo", status, amount::float8 AS amount, mode FROM "OpdPayment" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
      [invoiceId],
    );
    if (!pay) throw notFound("Invoice");
    if (pay.status !== "paid") throw conflict(`${pay.receiptNo} is already cancelled`);

    const reason = input.reason.trim();
    if (reason.length < 3) throw badRequest("Give a reason for the cancellation");

    const bills = await tx.query<BillRow>(`SELECT ${BILL_SELECT} FROM "Bill" b WHERE b."facilityId" = :fid AND b."paymentId" = $1 ORDER BY b.id FOR UPDATE`, [invoiceId]);
    const taken: string[] = [];
    const encounters = [];
    for (const bill of bills) {
      const e = await lockEncounter(tx, bill.encounterId);
      if (e && e.status !== "waiting") {
        const doctor = e.doctorId ? await findStaff(tx, e.doctorId) : null;
        taken.push(`${doctor?.name ?? e.department} (${e.department})`);
      }
      if (e) encounters.push(e);
    }
    if (taken.length > 0) {
      throw conflict(`${taken.join(", ")} ${taken.length === 1 ? "has" : "have"} already started, so ${pay.receiptNo} cannot be cancelled here. Ask an administrator.`);
    }

    const refund = round2(input.refundAmount ?? pay.amount);
    if (refund < 0 || refund > pay.amount) throw badRequest(`The refund must be between Rs 0 and Rs ${pay.amount}`);
    const refundMode = refund > 0 ? input.refundMode ?? pay.mode : null;
    const refundReference = input.refundReference?.trim() || null;
    if (refund > 0 && (refundMode === "upi" || refundMode === "card") && (!refundReference || refundReference.length < 3)) {
      throw badRequest(`Enter the ${refundMode === "upi" ? "UPI transaction id" : "card refund slip number"} for the refund`);
    }

    await tx.execute(
      `UPDATE "OpdPayment" SET status = 'cancelled', "cancelledAt" = now(), "cancelledByName" = $2, "cancelReason" = $3,
              "refundAmount" = $4, "refundMode" = $5, "refundReference" = $6 WHERE "facilityId" = :fid AND id = $1`,
      [invoiceId, user.name, reason, refund, refundMode, refundReference],
    );
    for (const bill of bills) await setBillStatus(tx, bill.id, "void");
    for (const e of encounters) await setStatus(tx, e.id, "cancelled");
    await recordAudit(
      tx,
      user.name,
      "OPD Invoice Cancelled",
      `${pay.receiptNo} Rs ${pay.amount.toFixed(2)}, refunded Rs ${refund.toFixed(2)}${refundMode ? ` (${refundMode}${refundReference ? `, ref ${refundReference}` : ""})` : ""}: ${reason}`,
    );
    return getInvoice(tx, invoiceId);
  });
}

/** The patient decided against this consultation (or left without paying): void its fee bill and cancel it. No token is issued. */
export async function cancelOpdVisit(db: Database, billId: string, actor: string) {
  return db.transaction(async (tx) => {
    const { bill, encounter } = await lockUnpaidFee(tx, billId);
    await setBillStatus(tx, bill.id, "void");
    await setStatus(tx, encounter.id, "cancelled");
    await recordAudit(tx, actor, "OPD Visit Cancelled Before Payment", `${bill.billNo} - ${encounter.department}`);
    return { encounter: await toEncounterDetail(tx, (await lockEncounter(tx, encounter.id))!) };
  });
}

// ---- routes --------------------------------------------------------------------------------------------

const pricingFields = {
  panelId: z.uuid().nullish(),
  beneficiaryId: z.string().trim().max(60).nullish(),
  discount: z
    .object({
      type: z.enum(["percent", "amount"]),
      value: z.number().positive().max(10_000_000),
      reason: z.string().trim().max(200).nullish(),
    })
    .nullish(),
};
const paymentFields = {
  paymentMode: z.enum(MODES),
  reference: z.string().trim().max(60).nullish(),
  amountReceived: z.number().min(0).max(10_000_000).nullish(),
};
const consultations = z.array(z.object({ department: z.string().trim().min(1).max(80), doctorId: z.uuid() })).min(1).max(6);

export function opdBillingRouter({ db }: HospitalContext): Router {
  const router = Router();
  const who = (req: Request): Collector => ({ id: req.staff?.id ?? null, name: req.staff?.name ?? "system" });
  /** Discounts, cancellations and refunds are for the billing counter and administrators, not the front desk. */
  const isCounter = (req: Request) => req.staff?.role === "biller" || req.staff?.role === "admin";
  const paymentOf = (b: { paymentMode: PaymentMode; reference?: string | null | undefined; amountReceived?: number | null | undefined }): PaymentInput => ({
    mode: b.paymentMode,
    reference: b.reference,
    amountReceived: b.amountReceived,
  });

  // Consultations registered but not yet paid for.
  router.get("/", async (_req, res) => {
    res.json(await listAwaitingOpd(db));
  });

  // What a set of doctors would cost, at standard or panel rates and with a discount: nothing is saved.
  router.post("/quote", async (req, res) => {
    const body = parse(z.object({ consultations: consultations.optional(), billIds: z.array(z.uuid()).max(6).optional(), ...pricingFields }), req.body);
    res.json(await db.transaction((tx) => quote(tx, body)));
  });

  // Invoices (a day or a range of days), newest first, with totals.
  router.get("/invoices", async (req, res) => {
    const q = parse(
      z.object({
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        status: z.enum(["all", "paid", "cancelled"]).default("all"),
        search: z.string().trim().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    res.json(await listInvoices(db, { from: q.from ?? null, to: q.to ?? null, status: q.status, search: q.search ?? null, limit: q.limit }));
  });

  router.get("/invoices/:id", async (req, res) => {
    res.json(await getInvoice(db, uuidParam(req)));
  });

  // OPD billing in one step: register for the chosen doctors, price, take payment, issue tokens and slips.
  router.post("/invoices", async (req, res) => {
    const body = parse(z.object({ patientId: z.uuid(), consultations, ...pricingFields, ...paymentFields }), req.body);
    const done = await createInvoice(
      db,
      { patientId: body.patientId, consultations: body.consultations, panelId: body.panelId, beneficiaryId: body.beneficiaryId, discount: body.discount, ...paymentOf(body) },
      who(req),
      isCounter(req),
    );
    res.status(201).json(done);
  });

  router.post("/invoices/:id/cancel", async (req, res) => {
    if (!isCounter(req)) throw forbidden("Only the billing counter or an administrator can cancel an invoice");
    const body = parse(
      z.object({
        reason: z.string().trim().min(1).max(300),
        refundAmount: z.number().min(0).max(10_000_000).nullish(),
        refundMode: z.enum(MODES).nullish(),
        refundReference: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    res.json({ invoice: await cancelInvoice(db, uuidParam(req), body, who(req)) });
  });

  // Register a patient for one or more doctors without paying yet (each waits in the awaiting-payment list).
  router.post("/visits", async (req, res) => {
    const body = parse(z.object({ patientId: z.uuid(), consultations }), req.body);
    res.status(201).json({ encounters: await registerConsultations(db, body.patientId, body.consultations, actorOf(req)) });
  });

  // One payment for one or more of a patient's registered consultation fees.
  router.post("/collect", async (req, res) => {
    const body = parse(z.object({ billIds: z.array(z.uuid()).min(1).max(6), ...pricingFields, ...paymentFields }), req.body);
    const done = await collectOpdPayment(
      db,
      { billIds: body.billIds, panelId: body.panelId, beneficiaryId: body.beneficiaryId, discount: body.discount, ...paymentOf(body) },
      who(req),
      isCounter(req),
    );
    res.json(done);
  });

  // The same for a single fee.
  router.post("/:billId/collect", async (req, res) => {
    const body = parse(z.object({ ...pricingFields, ...paymentFields }), req.body);
    const done = await collectOpdPayment(
      db,
      { billIds: [uuidParam(req, "billId")], panelId: body.panelId, beneficiaryId: body.beneficiaryId, discount: body.discount, ...paymentOf(body) },
      who(req),
      isCounter(req),
    );
    res.json({ bill: done.bills[0], encounter: done.encounters[0], invoice: done.invoice });
  });

  router.post("/:billId/cancel", async (req, res) => {
    res.json(await cancelOpdVisit(db, uuidParam(req, "billId"), actorOf(req)));
  });

  return router;
}

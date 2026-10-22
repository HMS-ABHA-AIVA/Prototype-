import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { listBedStays, type BedStayRow } from "../beds/beds.repository.js";
import { findBill } from "../billing/billing.repository.js";
import { findEncounter, listOrders, type EncounterRow } from "../encounters/encounters.repository.js";
import { findInvestigation } from "../masters/investigations.js";
import { itemRate, loadItemPricing, round2, type ItemPricing } from "../masters/item-pricing.js";
import { findBedService, findService } from "../masters/services.js";
import { getSettings, type Settings } from "../masters/settings.js";
import { findPanel } from "../panels/panels.js";
import { findPatient } from "../patients/patients.repository.js";
import { medicineLines } from "../pharmacy/pharmacy-billing.js";
import { findStaff } from "../staff/staff.js";

/**
 * The running bill of an admission: what the stay has cost so far. Bed days are posted automatically (one per bed day, at the rate of
 * the ward the patient was in); services and one-off items are added by the ward or the billing counter; tests and medicines are read from
 * the orders and the dispensed prescriptions. Advances taken and refunded sit alongside, giving the balance. The final bill (see
 * billing.service) is a snapshot of this taken after discharge.
 */

// ---- Indian calendar days -----------------------------------------------------------------------------------------------------

const IST_MS = 5.5 * 3600 * 1000;
/** The Indian calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (d: Date): string => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
/** The instant a given Indian date reaches a given hour. */
export const istInstant = (date: string, hour: number): Date => new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+05:30`));
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * The bed days of a stay: the day of admission, then one more for each later date on which the patient was still in hospital when
 * that date's checkout hour came (12:00 by default). The ward charged is the one the patient occupied at that moment.
 */
export function bedDaysFor(stays: BedStayRow[], admittedAt: Date, endAt: Date, checkoutHour: number): { date: string; ward: string }[] {
  if (stays.length === 0) return [];
  const wardAt = (t: Date, fallback: string) => {
    const stay = stays.find((s) => new Date(s.fromAt) <= t && (!s.toAt || t < new Date(s.toAt)));
    return stay?.ward ?? fallback;
  };
  const first = istDate(admittedAt);
  const days = [{ date: first, ward: stays[0]!.ward }];
  let previous = days[0]!.ward;
  for (let date = addDays(first, 1); istInstant(date, checkoutHour) <= endAt; date = addDays(date, 1)) {
    previous = wardAt(istInstant(date, checkoutHour), previous);
    days.push({ date, ward: previous });
  }
  return days;
}

// ---- Shapes -------------------------------------------------------------------------------------------------------------------

export type LineSource = "bed" | "service" | "custom" | "investigation" | "medicine";

export interface BillLine {
  id: string | null;
  source: LineSource;
  date: string | null;
  description: string;
  qty: number;
  rate: number;
  standardRate: number;
  gstPct: number;
  /** qty x rate plus GST */
  amount: number;
  serviceId: string | null;
  voided: boolean;
  voidReason: string | null;
  postedBy: string | null;
}

export interface PaymentRow {
  id: string;
  receiptNo: string;
  encounterId: string;
  patientId: string;
  kind: "advance" | "refund" | "settlement";
  amount: number;
  mode: "cash" | "upi" | "card" | "other";
  reference: string | null;
  note: string | null;
  billId: string | null;
  receivedBy: string;
  at: string;
  cancelled: boolean;
  cancelReason: string | null;
  cancelledBy: string | null;
}

export interface RunningBill {
  encounterId: string;
  encounterType: "OPD" | "IPD" | "ER";
  status: string;
  patient: { id: string; mrn: string; name: string; yearOfBirth: number | null; gender: string | null; phone: string | null };
  doctorName: string | null;
  department: string;
  admittedAt: string | null;
  dischargedAt: string | null;
  /** The bed the patient is in now (or was last in). */
  bed: { ward: string; bedNo: string } | null;
  panel: { id: string; code: string; name: string } | null;
  beneficiaryId: string | null;
  lines: BillLine[];
  subtotal: number;
  gstTotal: number;
  total: number;
  payments: PaymentRow[];
  /** Advances taken less any refunded during the stay. */
  advancesHeld: number;
  /** What is still to pay (negative: the hospital owes the patient). */
  balance: number;
  /** Things the billing counter should look at (a ward with no bed charge set ...). */
  warnings: string[];
  bill: { id: string; billNo: string; status: string } | null;
}

export const PAYMENT_COLUMNS = `id, "receiptNo", "encounterId", "patientId", kind, amount::float8 AS amount, mode, reference, note, "billId", "receivedBy", at,
  cancelled, "cancelReason", "cancelledBy"`;

const CHARGE_COLUMNS = `id, "chargeDate", kind, "serviceId", description, qty, "standardRate"::float8 AS "standardRate", rate::float8 AS rate,
  "gstPct"::float8 AS "gstPct", "postedBy", voided, "voidReason"`;

const lineAmount = (qty: number, rate: number, gstPct: number) => round2(qty * rate * (1 + gstPct / 100));

export async function requireIpd(db: Queryable, encounterId: string): Promise<EncounterRow> {
  const encounter = await findEncounter(db, encounterId);
  if (!encounter) throw notFound("Admission");
  if (encounter.type !== "IPD") throw badRequest("This is not an inpatient admission");
  return encounter;
}

// ---- Posting bed days --------------------------------------------------------------------------------------------------------

/** Posts any bed day that is due and not yet on the bill. Safe to call as often as you like: a day is only ever posted once. */
export async function postBedDays(tx: Queryable, encounter: EncounterRow, settings: Settings, pricing: ItemPricing, now = new Date()): Promise<string[]> {
  const warnings: string[] = [];
  if (!encounter.admittedAt) return warnings;
  const stays = await listBedStays(tx, encounter.id);
  const days = bedDaysFor(stays, new Date(encounter.admittedAt), encounter.dischargedAt ? new Date(encounter.dischargedAt) : now, settings.bedDayCheckoutHour);
  if (days.length === 0) return warnings;

  // A day already on the bill, even a voided one, is not posted again.
  const existing = new Set(
    (await tx.query<{ chargeDate: string }>(`SELECT "chargeDate" FROM "IpdCharge" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'bed'`, [encounter.id])).map(
      (r) => r.chargeDate,
    ),
  );
  const missingRate = new Set<string>();
  for (const day of days) {
    if (existing.has(day.date)) continue;
    const service = await findBedService(tx, day.ward);
    if (!service) {
      missingRate.add(day.ward);
      continue;
    }
    const { rate, standard } = itemRate(pricing, "service", service);
    await tx.execute(
      `INSERT INTO "IpdCharge" ("facilityId", "encounterId", "chargeDate", kind, "serviceId", description, qty, "standardRate", rate, "gstPct", "postedBy")
       VALUES (:fid, $1,$2,'bed',$3,$4,1,$5,$6,$7,'system') ON CONFLICT DO NOTHING`,
      [encounter.id, day.date, service.id, `Bed charge: ${day.ward}`, standard, rate, service.gstPct],
    );
  }
  for (const ward of missingRate) warnings.push(`No daily bed charge is set for ${ward}: set it under Masters > Wards, then open this bill again.`);
  return warnings;
}

// ---- Reading the running bill ------------------------------------------------------------------------------------------------------

export const listPayments = (db: Queryable, encounterId: string) =>
  db.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM "IpdPayment" WHERE "facilityId" = :fid AND "encounterId" = $1 ORDER BY at, "receiptNo"`, [encounterId]);

/** Advances taken less any refunded during the stay (not counting a settlement or the refund made when the final bill was paid). */
export function advancesHeld(payments: PaymentRow[]): number {
  return round2(payments.filter((p) => !p.cancelled && !p.billId).reduce((sum, p) => sum + (p.kind === "advance" ? p.amount : p.kind === "refund" ? -p.amount : 0), 0));
}

export async function runningBill(tx: Queryable, encounterId: string, options: { post: boolean }): Promise<RunningBill> {
  const encounter = await findEncounter(tx, encounterId);
  if (!encounter) throw notFound("Admission");
  const [patient, doctor, settings, panel] = await Promise.all([
    findPatient(tx, encounter.patientId),
    encounter.doctorId ? findStaff(tx, encounter.doctorId) : null,
    getSettings(tx),
    encounter.panelId ? findPanel(tx, encounter.panelId) : null,
  ]);
  if (!patient) throw notFound("Patient");
  const pricing = await loadItemPricing(tx, encounter.panelId);

  const warnings = encounter.type === "IPD" && options.post ? await postBedDays(tx, encounter, settings, pricing) : [];

  const lines: BillLine[] = [];
  const charges = await tx.query<{
    id: string;
    chargeDate: string;
    kind: "bed" | "service" | "custom";
    serviceId: string | null;
    description: string;
    qty: number;
    standardRate: number;
    rate: number;
    gstPct: number;
    postedBy: string;
    voided: boolean;
    voidReason: string | null;
  }>(`SELECT ${CHARGE_COLUMNS} FROM "IpdCharge" WHERE "facilityId" = :fid AND "encounterId" = $1 ORDER BY "chargeDate", kind <> 'bed', "postedAt"`, [encounterId]);
  for (const c of charges) {
    lines.push({
      id: c.id, source: c.kind, date: c.chargeDate, description: c.description, qty: c.qty, rate: c.rate, standardRate: c.standardRate, gstPct: c.gstPct,
      amount: lineAmount(c.qty, c.rate, c.gstPct), serviceId: c.serviceId, voided: c.voided, voidReason: c.voidReason, postedBy: c.postedBy,
    });
  }

  for (const order of await listOrders(tx, encounterId)) {
    const test = order.investigationId ? await findInvestigation(tx, order.investigationId) : null;
    const price = test ? itemRate(pricing, "investigation", test) : { rate: settings.unlistedTestPrice, standard: settings.unlistedTestPrice };
    const gst = test?.gstPct ?? 0;
    lines.push({
      id: null, source: "investigation", date: istDate(new Date(order.createdAt)), description: `${order.type === "lab" ? "Lab Test" : "Radiology"}: ${order.name}`,
      qty: 1, rate: price.rate, standardRate: price.standard, gstPct: gst, amount: lineAmount(1, price.rate, gst), serviceId: null, voided: false, voidReason: null,
      postedBy: null,
    });
  }

  // Medicines: what the pharmacy handed over for this stay, each at its taxable value (the MRP less GST) so the bill comes back to the MRP.
  for (const m of await medicineLines(tx, encounterId, settings)) {
    lines.push({
      id: null, source: "medicine", date: m.date, description: m.label, qty: 1, rate: m.rate, standardRate: m.rate, gstPct: m.gstPct,
      amount: lineAmount(1, m.rate, m.gstPct), serviceId: null, voided: false, voidReason: null, postedBy: null,
    });
  }

  const live = lines.filter((l) => !l.voided);
  const subtotal = round2(live.reduce((sum, l) => sum + l.qty * l.rate, 0));
  const total = round2(live.reduce((sum, l) => sum + l.amount, 0));
  const payments = await listPayments(tx, encounterId);
  const held = advancesHeld(payments);
  const stays = await listBedStays(tx, encounterId);
  const lastStay = stays[stays.length - 1];
  const bill = await tx.queryOne<{ id: string; billNo: string; status: string }>(
    `SELECT id, "billNo", status FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'final'`,
    [encounterId],
  );

  return {
    encounterId, encounterType: encounter.type, status: encounter.status,
    patient: { id: patient.id, mrn: patient.mrn, name: patient.name, yearOfBirth: patient.yearOfBirth, gender: patient.gender, phone: patient.phone },
    doctorName: doctor?.name ?? null, department: encounter.department, admittedAt: encounter.admittedAt, dischargedAt: encounter.dischargedAt,
    bed: lastStay ? { ward: lastStay.ward, bedNo: lastStay.bedNo } : null,
    panel: panel ? { id: panel.id, code: panel.code, name: panel.name } : null, beneficiaryId: encounter.beneficiaryId,
    lines, subtotal, gstTotal: round2(total - subtotal), total,
    payments, advancesHeld: held, balance: round2(total - held), warnings, bill,
  };
}

// ---- Charges -------------------------------------------------------------------------------------------------------------------------

export interface ChargeInput {
  serviceId?: string | undefined;
  description?: string | undefined;
  qty: number;
  /** Overrides the master / panel rate. Needs billing-counter rights and a reason. */
  rate?: number | undefined;
  gstPct?: number | undefined;
  rateNote?: string | undefined;
  date?: string | undefined;
}

/** A charge can be added or voided while the patient is admitted, or after discharge until the final bill is finalized (by the counter). */
async function requireOpenForCharges(tx: Queryable, encounter: EncounterRow, byCounter: boolean) {
  if (encounter.status === "admitted") return;
  const finalBill = await tx.queryOne<{ id: string }>(`SELECT id FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'final'`, [encounter.id]);
  const bill = finalBill ? await findBill(tx, finalBill.id) : null;
  if (encounter.status === "discharged" && byCounter && (!bill || bill.status === "draft")) return;
  throw conflict(encounter.status === "discharged" ? "The final bill has been finalized: charges can no longer be changed" : "This admission is not open for charges");
}

export async function addCharge(tx: Queryable, encounterId: string, input: ChargeInput, actor: string, byCounter: boolean): Promise<void> {
  const encounter = await requireIpd(tx, encounterId);
  await requireOpenForCharges(tx, encounter, byCounter);
  const pricing = await loadItemPricing(tx, encounter.panelId);
  const today = istDate(new Date());
  const date = input.date ?? today;
  if (date > today) throw badRequest("A charge cannot be dated in the future");
  if (encounter.admittedAt && date < istDate(new Date(encounter.admittedAt))) throw badRequest("A charge cannot be dated before the admission");

  if (input.serviceId) {
    const service = await findService(tx, input.serviceId);
    if (!service || !service.active) throw notFound("Service");
    if (service.category === "bed") throw badRequest("Bed charges are added automatically for each day in the ward");
    const price = itemRate(pricing, "service", service);
    const overridden = input.rate !== undefined && input.rate !== price.rate;
    if (overridden && !byCounter) throw badRequest("Only the billing counter can change a rate");
    if (overridden && (input.rateNote ?? "").trim().length < 3) throw badRequest("Give a reason for changing the rate");
    const rate = input.rate ?? price.rate;
    await tx.execute(
      `INSERT INTO "IpdCharge" ("facilityId", "encounterId", "chargeDate", kind, "serviceId", description, qty, "standardRate", rate, "gstPct", "rateNote", "postedBy")
       VALUES (:fid, $1,$2,'service',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [encounterId, date, service.id, service.name, input.qty, price.standard, rate, input.gstPct ?? service.gstPct, overridden ? input.rateNote!.trim() : null, actor],
    );
    await recordAudit(tx, actor, "IPD Charge Added", `${service.name} x${input.qty} @ Rs ${rate}${overridden ? ` (rate changed from Rs ${price.rate}: ${input.rateNote})` : ""}`);
    return;
  }

  // A one-off item that is not in the services list: counter only, and it needs a description and a price.
  if (!byCounter) throw badRequest("Choose a service from the list");
  if (!input.description?.trim() || input.rate === undefined) throw badRequest("Give a description and a rate");
  await tx.execute(
    `INSERT INTO "IpdCharge" ("facilityId", "encounterId", "chargeDate", kind, description, qty, "standardRate", rate, "gstPct", "rateNote", "postedBy")
     VALUES (:fid, $1,$2,'custom',$3,$4,$5,$5,$6,$7,$8)`,
    [encounterId, date, input.description.trim(), input.qty, input.rate, input.gstPct ?? 0, input.rateNote?.trim() || null, actor],
  );
  await recordAudit(tx, actor, "IPD Charge Added", `${input.description.trim()} x${input.qty} @ Rs ${input.rate} (not in the services list)`);
}

export async function voidCharge(tx: Queryable, encounterId: string, chargeId: string, reason: string, actor: string): Promise<void> {
  const encounter = await requireIpd(tx, encounterId);
  await requireOpenForCharges(tx, encounter, true);
  const charge = await tx.queryOne<{ id: string; description: string; voided: boolean }>(
    'SELECT id, description, voided FROM "IpdCharge" WHERE "facilityId" = :fid AND id = $1 AND "encounterId" = $2 FOR UPDATE',
    [chargeId, encounterId],
  );
  if (!charge) throw notFound("Charge");
  if (charge.voided) throw conflict("That charge is already voided");
  if (reason.trim().length < 3) throw badRequest("Give a reason for voiding the charge");
  await tx.execute('UPDATE "IpdCharge" SET voided = true, "voidReason" = $2, "voidedBy" = $3, "voidedAt" = now() WHERE "facilityId" = :fid AND id = $1', [
    chargeId, reason.trim(), actor,
  ]);
  await recordAudit(tx, actor, "IPD Charge Voided", `${charge.description}: ${reason.trim()}`);
}

/** Changes what the stay is billed under (null = self-pay). With `reprice`, the unvoided service and bed lines are re-rated for the new category. */
export async function setBilling(tx: Queryable, encounterId: string, panelId: string | null, beneficiaryId: string | undefined, reprice: boolean, actor: string): Promise<void> {
  const encounter = await requireIpd(tx, encounterId);
  if (encounter.status !== "admitted" && encounter.status !== "discharged") throw conflict("This admission is not open");
  const finalBill = await tx.queryOne<{ status: string }>(`SELECT status FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'final'`, [encounterId]);
  if (finalBill && finalBill.status !== "draft") throw conflict("The final bill has been finalized: the billing category can no longer be changed");

  let panelCode = "Self-pay";
  if (panelId) {
    const panel = await findPanel(tx, panelId);
    if (!panel || !panel.active) throw badRequest("That billing category is not available");
    if (panel.requiresBeneficiaryId && !beneficiaryId?.trim()) throw badRequest(`Enter the ${panel.code} beneficiary / card number`);
    panelCode = panel.code;
  }
  await tx.execute('UPDATE "Encounter" SET "panelId" = $2, "beneficiaryId" = $3, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [
    encounterId, panelId, panelId ? beneficiaryId?.trim() || null : null,
  ]);

  if (reprice) {
    const pricing = await loadItemPricing(tx, panelId);
    const rows = await tx.query<{ id: string; serviceId: string }>(
      'SELECT id, "serviceId" FROM "IpdCharge" WHERE "facilityId" = :fid AND "encounterId" = $1 AND NOT voided AND "serviceId" IS NOT NULL AND "rateNote" IS NULL',
      [encounterId],
    );
    for (const row of rows) {
      const service = await findService(tx, row.serviceId);
      if (!service) continue;
      const { rate, standard } = itemRate(pricing, "service", service);
      await tx.execute('UPDATE "IpdCharge" SET rate = $2, "standardRate" = $3 WHERE "facilityId" = :fid AND id = $1', [row.id, rate, standard]);
    }
  }
  await recordAudit(tx, actor, "IPD Billing Category Set", `${panelCode}${reprice ? " (charges re-rated)" : ""}`);
}

// ---- Advances, refunds and receipts --------------------------------------------------------------------------------------------------

export interface PaymentInput {
  amount: number;
  mode: PaymentRow["mode"];
  reference?: string | undefined;
  note?: string | undefined;
}

/** UPI and card payments need the transaction id or slip number, so the receipt can be matched to the statement. */
export function requireReference(mode: PaymentRow["mode"], reference: string | undefined) {
  if ((mode === "upi" || mode === "card") && (reference ?? "").trim().length < 3) {
    throw badRequest(mode === "upi" ? "Enter the UPI transaction id" : "Enter the card slip number or last digits");
  }
}

export async function insertPayment(
  tx: Queryable,
  encounter: { id: string; patientId: string },
  kind: PaymentRow["kind"],
  input: PaymentInput,
  actor: string,
  billId: string | null = null,
): Promise<PaymentRow> {
  const prefix = kind === "advance" ? "ADV" : kind === "refund" ? "RF" : "IPD";
  // Receipt numbers run per hospital: ADV-1, RF-2, IPD-3 ... (one series for all three kinds)
  const row = await tx.queryOne<PaymentRow>(
    `INSERT INTO "IpdPayment" ("facilityId", "receiptNo", "encounterId", "patientId", kind, amount, mode, reference, note, "billId", "receivedBy")
     VALUES (:fid, $1 || '-' || next_facility_number(:fid, 'ipd_receipt', 1), $2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PAYMENT_COLUMNS}`,
    [prefix, encounter.id, encounter.patientId, kind, round2(input.amount), input.mode, input.reference?.trim() || null, input.note?.trim() || null, billId, actor],
  );
  return row!;
}

export async function takeAdvance(tx: Queryable, encounterId: string, input: PaymentInput, actor: string): Promise<PaymentRow> {
  const encounter = await requireIpd(tx, encounterId);
  if (encounter.status !== "admitted") throw conflict("Advances are taken while the patient is admitted");
  requireReference(input.mode, input.reference);
  const row = await insertPayment(tx, encounter, "advance", input, actor);
  await recordAudit(tx, actor, "IPD Advance Received", `${row.receiptNo} Rs ${row.amount} (${row.mode})`);
  return row;
}

/** Gives back part of the advance held, during the stay. */
export async function refundAdvance(tx: Queryable, encounterId: string, input: PaymentInput & { reason: string }, actor: string): Promise<PaymentRow> {
  const encounter = await requireIpd(tx, encounterId);
  const payments = await listPayments(tx, encounterId);
  if (input.amount > advancesHeld(payments)) throw badRequest("That is more than the advance held");
  if (input.reason.trim().length < 3) throw badRequest("Give a reason for the refund");
  requireReference(input.mode, input.reference);
  const row = await insertPayment(tx, encounter, "refund", { ...input, note: input.reason }, actor);
  await recordAudit(tx, actor, "IPD Advance Refunded", `${row.receiptNo} Rs ${row.amount} (${row.mode}): ${input.reason.trim()}`);
  return row;
}

/** An advance entered by mistake. It stays on record, marked cancelled with the reason. */
export async function cancelAdvance(tx: Queryable, encounterId: string, paymentId: string, reason: string, actor: string): Promise<void> {
  await requireIpd(tx, encounterId);
  const payment = await tx.queryOne<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM "IpdPayment" WHERE "facilityId" = :fid AND id = $1 AND "encounterId" = $2 FOR UPDATE`,
    [paymentId, encounterId],
  );
  if (!payment) throw notFound("Receipt");
  if (payment.kind !== "advance") throw badRequest("Only an advance receipt can be cancelled");
  if (payment.cancelled) throw conflict("That receipt is already cancelled");
  if (reason.trim().length < 3) throw badRequest("Give a reason for cancelling the receipt");
  const paidBill = await tx.queryOne(`SELECT 1 FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'final' AND status = 'paid'`, [encounterId]);
  if (paidBill) throw conflict("The final bill has been paid: the receipt can no longer be cancelled");
  const held = advancesHeld(await listPayments(tx, encounterId));
  if (payment.amount > held) throw conflict("Part of this advance has already been refunded: refund cannot exceed what is held");
  await tx.execute('UPDATE "IpdPayment" SET cancelled = true, "cancelReason" = $2, "cancelledBy" = $3, "cancelledAt" = now() WHERE "facilityId" = :fid AND id = $1', [
    paymentId, reason.trim(), actor,
  ]);
  await recordAudit(tx, actor, "IPD Advance Receipt Cancelled", `${payment.receiptNo}: ${reason.trim()}`);
}

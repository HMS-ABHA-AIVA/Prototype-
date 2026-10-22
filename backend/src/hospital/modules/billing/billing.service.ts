import type { Database, Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { findEncounter, listOrders, markBilled } from "../encounters/encounters.repository.js";
import { advancesHeld, insertPayment, listPayments, PAYMENT_COLUMNS, requireReference, runningBill, type BillLine, type PaymentRow } from "../ipd/running-bill.js";
import { findInvestigation } from "../masters/investigations.js";
import { itemRate, loadItemPricing, round2 } from "../masters/item-pricing.js";
import { getSettings } from "../masters/settings.js";
import { findPanel } from "../panels/panels.js";
import { medicineLines } from "../pharmacy/pharmacy-billing.js";
import { findStaff } from "../staff/staff.js";
import {
  encounterTypes, findBill, findBillByEncounter, insertBill, insertBillItem, listBillItemsForMany, listBills, lockBill, payBill, setBillDiscount, setBillPanel,
  setBillStatus, type BillRow, type NewBillItem,
} from "./billing.repository.js";

const OPD_FEE_LABEL = "OPD Consultation Fee";

/** Bills with their lines and totals worked out (a few queries however many bills there are). */
export async function toBillDtos(db: Queryable, bills: BillRow[]) {
  if (bills.length === 0) return [];
  const [allItems, types] = await Promise.all([listBillItemsForMany(db, bills.map((b) => b.id)), encounterTypes(db, bills.map((b) => b.encounterId))]);
  const typeOf = new Map(types.map((t) => [t.id, t.type]));

  // Inpatient bills also carry what was paid in advance, so the counter can see what is left to pay.
  const ipdIds = [...new Set(bills.filter((b) => b.kind === "final" && typeOf.get(b.encounterId) === "IPD").map((b) => b.encounterId))];
  const payments = ipdIds.length
    ? await db.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM "IpdPayment" WHERE "facilityId" = :fid AND "encounterId" = ANY($1::text[]) ORDER BY at, "receiptNo"`, [ipdIds])
    : [];

  return bills.map((bill) => {
    const items = allItems.filter((item) => item.billId === bill.id).map((item) => ({ ...item, amount: round2(item.qty * item.rate * (1 + item.gstPct / 100)) }));
    const subtotal = round2(items.reduce((sum, i) => sum + i.qty * i.rate, 0));
    const total = round2(items.reduce((sum, i) => sum + i.amount, 0));
    const discountAmount = round2(-items.filter((i) => i.isDiscount).reduce((sum, i) => sum + i.qty * i.rate, 0));
    const own = payments.filter((p) => p.encounterId === bill.encounterId);
    const held = ipdIds.includes(bill.encounterId) ? advancesHeld(own) : 0;
    return {
      ...bill,
      encounterType: typeOf.get(bill.encounterId) ?? null,
      items,
      subtotal,
      gstTotal: round2(total - subtotal),
      total,
      discountAmount,
      /** Advances the patient has paid in (inpatient bills). */
      advancesHeld: held,
      /** What is still to pay once advances are taken off (negative: the hospital owes the patient a refund). Zero once paid. */
      balance: bill.status === "paid" ? 0 : round2(total - held),
      /** The receipts for money taken or given back when this bill was settled. */
      settlement: own.filter((p) => p.billId === bill.id && !p.cancelled),
    };
  });
}
export const toBillDto = async (db: Queryable, bill: BillRow) => (await toBillDtos(db, [bill]))[0]!;
export type BillDto = Awaited<ReturnType<typeof toBillDto>>;

/**
 * The consultation-fee bill raised when an OPD visit is sent to OPD billing. It is paid at the counter ("Collect payment" in the
 * opd-billing module) before the patient joins the queue, never through finalize/pay.
 */
export async function createOpdFeeBill(
  db: Queryable,
  encounterId: string,
  patientId: string,
  consultation: { doctorName: string; department: string; fee: number },
  actor: string,
): Promise<BillDto> {
  const bill = (await insertBill(db, encounterId, patientId, "opd_fee", consultation.fee))!;
  await insertBillItem(db, bill.id, { label: `${OPD_FEE_LABEL}: ${consultation.doctorName} (${consultation.department})`, qty: 1, rate: consultation.fee, gstPct: 0 });
  await recordAudit(db, actor, "OPD Fee Bill Raised", `${bill.billNo} - ${consultation.doctorName}, Rs ${consultation.fee}`);
  return toBillDto(db, bill);
}

// ---- Discounts -------------------------------------------------------------------------------------------------------------

export interface DiscountInput {
  type: "percent" | "amount";
  value: number;
  reason: string;
}

/**
 * The negative lines that take a discount off a bill. They are shared across the GST rates in proportion to what each rate holds, so the
 * tax on the discounted bill stays right, and the lines add up to exactly the discount asked for.
 */
export function discountLines(items: { qty: number; rate: number; gstPct: number }[], discount: DiscountInput): NewBillItem[] {
  const groups = new Map<number, number>();
  for (const item of items) groups.set(item.gstPct, round2((groups.get(item.gstPct) ?? 0) + item.qty * item.rate));
  const taxable = round2([...groups.values()].reduce((sum, v) => sum + v, 0));
  if (taxable <= 0) throw badRequest("There is nothing on the bill to discount");
  if (discount.type === "percent" && (discount.value <= 0 || discount.value > 100)) throw badRequest("A percentage discount is between 0 and 100");
  const total = discount.type === "percent" ? round2((taxable * discount.value) / 100) : round2(discount.value);
  if (total <= 0) throw badRequest("Enter a discount greater than zero");
  if (total > taxable) throw badRequest(`The discount (Rs ${total}) is more than the bill (Rs ${taxable})`);

  const rates = [...groups.keys()].sort((a, b) => a - b);
  let left = total;
  return rates.map((gstPct, i) => {
    const share = i === rates.length - 1 ? left : round2((total * groups.get(gstPct)!) / taxable);
    left = round2(left - share);
    const label = `Discount (${discount.reason.trim()})${rates.length > 1 ? ` - items at GST ${gstPct}%` : ""}`;
    return { label, qty: 1, rate: -share, gstPct, isDiscount: true };
  });
}

// ---- Building a bill from a stay or visit ------------------------------------------------------------------------------------------

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

const billItemOf = (line: BillLine): NewBillItem => ({
  label: line.date && (line.source === "bed" || line.source === "service" || line.source === "custom") ? `${line.description} (${dayLabel(line.date)})` : line.description,
  qty: line.qty,
  rate: line.rate,
  gstPct: line.gstPct,
});

/** Rebuilds an inpatient draft bill from the running bill (bed days, charges, tests, medicines) and applies its discount, if any. */
async function fillIpdBill(tx: Queryable, bill: BillRow, actor: string): Promise<BillRow> {
  const running = await runningBill(tx, bill.encounterId, { post: true });
  // A stay with no charges yet (no ward rate set, say) still gets its draft bill: the counter adds what is missing before finalizing.
  const items = running.lines.filter((l) => !l.voided).map(billItemOf);

  await tx.execute('DELETE FROM "BillItem" WHERE "facilityId" = :fid AND "billId" = $1', [bill.id]);
  for (const item of items) await insertBillItem(tx, bill.id, item);
  if (bill.discountType && bill.discountValue !== null && bill.discountReason) {
    for (const line of discountLines(items, { type: bill.discountType, value: bill.discountValue, reason: bill.discountReason })) await insertBillItem(tx, bill.id, line);
  }
  await setBillPanel(tx, bill.id, running.panel ? { id: running.panel.id, name: running.panel.name, beneficiaryId: running.beneficiaryId } : null);
  await recordAudit(tx, actor, "Bill Prepared", `${bill.billNo}: ${items.length} line(s) from the admission`);
  return (await findBill(tx, bill.id))!;
}

/**
 * Creates the draft bill for the rest of an encounter. An OPD visit: the consultation fee (unless OPD billing already collected it),
 * every test and every medicine dispensed. An ER visit: the emergency fee, tests and medicines. An admission: every bed day, service,
 * test and medicine on its running bill. Tests are priced from the hospital's test list, medicines from the stock list, bed days from
 * the ward's rate (all for the panel the stay is billed under). Call it inside the transaction that closes the encounter.
 *
 * Calling it again returns the same bill, except that an admission's draft is refreshed from the running bill (so charges added since
 * are included). Returns null for an OPD visit whose consultation fee was already collected and which has nothing else to bill.
 */
export async function generateBillForEncounter(db: Queryable, encounterId: string, actor: string): Promise<BillDto | null> {
  const encounter = await findEncounter(db, encounterId);
  if (!encounter) throw notFound("Encounter");

  const existing = await findBillByEncounter(db, encounterId);
  if (existing) {
    if (encounter.type === "IPD" && existing.status === "draft" && encounter.status !== "admitted") return toBillDto(db, await fillIpdBill(db, existing, actor));
    return toBillDto(db, existing);
  }

  if (encounter.type === "IPD") {
    // The final bill is made once the patient is discharged (before that, the running bill shows the cost so far).
    if (encounter.status === "admitted") return null;
    const panel = encounter.panelId ? await findPanel(db, encounter.panelId) : null;
    const bill = (await insertBill(db, encounterId, encounter.patientId, "final", null, panel ? { id: panel.id, name: panel.name, beneficiaryId: encounter.beneficiaryId } : null))!;
    await recordAudit(db, actor, "Bill Generated", `${bill.billNo} for IPD encounter`);
    return toBillDto(db, await fillIpdBill(db, bill, actor));
  }

  const settings = await getSettings(db);
  const pricing = await loadItemPricing(db, encounter.panelId);
  const feeAlreadyBilled = encounter.type === "OPD" && !!(await findBillByEncounter(db, encounterId, "opd_fee"));
  const lines: NewBillItem[] = [];
  if (!feeAlreadyBilled) {
    if (encounter.type === "ER") lines.push({ label: "Emergency Consultation & Triage Fee", qty: 1, rate: settings.erFee, gstPct: 0 });
    else lines.push({ label: OPD_FEE_LABEL, qty: 1, rate: (encounter.doctorId ? (await findStaff(db, encounter.doctorId))?.opdFee : null) ?? settings.opdDefaultFee, gstPct: 0 });
  }
  for (const order of await listOrders(db, encounterId)) {
    const test = order.investigationId ? await findInvestigation(db, order.investigationId) : null;
    const price = test ? itemRate(pricing, "investigation", test).rate : settings.unlistedTestPrice;
    lines.push({ label: `${order.type === "lab" ? "Lab Test" : "Radiology"}: ${order.name}`, qty: 1, rate: price, gstPct: test?.gstPct ?? 0 });
  }
  for (const m of await medicineLines(db, encounterId, settings)) lines.push({ label: m.label, qty: 1, rate: m.rate, gstPct: m.gstPct });
  if (lines.length === 0) return null;

  const bill = (await insertBill(db, encounterId, encounter.patientId))!;
  for (const line of lines) await insertBillItem(db, bill.id, line);
  await recordAudit(db, actor, "Bill Generated", `${bill.billNo} for ${encounter.type} encounter`);
  return toBillDto(db, bill);
}

const OPEN_VISIT = ["awaiting_payment", "waiting", "in_consult", "in_er"];

/**
 * A medicine handed over after an OPD or emergency visit was closed (the usual order: the doctor finishes, then the patient goes
 * to the pharmacy) belongs on that visit's bill: it is added to the draft bill, or a draft bill is made for it when the visit had
 * none (its consultation fee was collected up front and nothing else was charged). An open visit's bill is made when it closes,
 * and an admission's medicines are on its running bill, so neither needs anything here. A bill already finalised cannot change:
 * that is recorded in the audit log so the counter can charge the medicine separately.
 */
export async function billLateMedicines(tx: Queryable, encounterId: string, actor: string): Promise<{ billNo: string | null; alreadyFinalised: boolean }> {
  const encounter = await findEncounter(tx, encounterId);
  if (!encounter || encounter.type === "IPD" || OPEN_VISIT.includes(encounter.status)) return { billNo: null, alreadyFinalised: false };

  const existing = await findBillByEncounter(tx, encounterId);
  if (!existing) {
    const bill = await generateBillForEncounter(tx, encounterId, actor);
    return { billNo: bill?.billNo ?? null, alreadyFinalised: false };
  }
  if (existing.status !== "draft") {
    await recordAudit(tx, actor, "Medicine Dispensed After Billing", `${existing.billNo} was already ${existing.status}: charge the medicine separately`);
    return { billNo: existing.billNo, alreadyFinalised: true };
  }

  // Add the medicine lines the draft does not have yet (a line is matched by its wording, as many times as it appears).
  const onBill = (await toBillDto(tx, existing)).items.filter((i) => !i.isDiscount).map((i) => i.label);
  let added = 0;
  for (const line of await medicineLines(tx, encounterId, await getSettings(tx))) {
    const at = onBill.indexOf(line.label);
    if (at >= 0) onBill.splice(at, 1);
    else {
      await insertBillItem(tx, existing.id, { label: line.label, qty: 1, rate: line.rate, gstPct: line.gstPct });
      added++;
    }
  }
  if (added > 0) {
    // A discount is worked out from the bill's lines, so it is worked out again.
    if (existing.discountType && existing.discountValue !== null) {
      await applyDiscountIn(tx, existing.id, { type: existing.discountType, value: existing.discountValue, reason: existing.discountReason ?? "" }, actor);
    }
    await recordAudit(tx, actor, "Bill Updated", `${existing.billNo}: ${added} medicine line(s) dispensed after the visit`);
  }
  return { billNo: existing.billNo, alreadyFinalised: false };
}

export async function getBill(db: Database, id: string): Promise<BillDto> {
  const bill = await findBill(db, id);
  if (!bill) throw notFound("Bill");
  return toBillDto(db, bill);
}

export async function listBillDtos(db: Database, patientId: string | null, limit: number): Promise<BillDto[]> {
  return toBillDtos(db, await listBills(db, patientId, limit));
}

/** Sets or clears the discount on a draft final bill (billing counter and administrators), then rebuilds its lines. */
export const applyDiscount = (db: Database, id: string, discount: DiscountInput | null, actor: string): Promise<BillDto> =>
  db.transaction((tx) => applyDiscountIn(tx, id, discount, actor));

async function applyDiscountIn(tx: Queryable, id: string, discount: DiscountInput | null, actor: string): Promise<BillDto> {
  const bill = await lockBill(tx, id);
  if (!bill) throw notFound("Bill");
  if (bill.kind !== "final") throw conflict("A discount on an OPD consultation fee is given at OPD billing");
  if (bill.status !== "draft") throw conflict(`Bill ${bill.billNo} is already ${bill.status}: a discount can only be changed on a draft`);
  if (discount && discount.reason.trim().length < 3) throw badRequest("Give a reason for the discount");

  const encounter = (await findEncounter(tx, bill.encounterId))!;
  await setBillDiscount(tx, id, discount ? { ...discount, reason: discount.reason.trim() } : null);
  if (encounter.type === "IPD") {
    await fillIpdBill(tx, (await findBill(tx, id))!, actor);
  } else {
    const base = (await toBillDto(tx, bill)).items.filter((i) => !i.isDiscount);
    await tx.execute('DELETE FROM "BillItem" WHERE "facilityId" = :fid AND "billId" = $1 AND "isDiscount"', [id]);
    if (discount) for (const line of discountLines(base, { ...discount, reason: discount.reason.trim() })) await insertBillItem(tx, id, line);
  }
  await recordAudit(
    tx,
    actor,
    discount ? "Bill Discount Given" : "Bill Discount Removed",
    `${bill.billNo}${discount ? `: ${discount.type === "percent" ? `${discount.value}%` : `Rs ${discount.value}`} - ${discount.reason.trim()}` : ""}`,
  );
  return toBillDto(tx, (await findBill(tx, id))!);
}

/** draft -> finalized: the bill can no longer change and the encounter is marked billed. An admission's bill is refreshed first, so nothing added late is missed. */
export async function finalizeBill(db: Database, id: string, actor: string): Promise<BillDto> {
  return db.transaction(async (tx) => {
    let bill = await lockBill(tx, id);
    if (!bill) throw notFound("Bill");
    if (bill.kind === "opd_fee") throw conflict(`${bill.billNo} is an OPD consultation fee: collect it at OPD billing ("Collect payment")`);
    if (bill.status !== "draft") throw conflict(`Bill ${bill.billNo} is already ${bill.status}`);
    const encounter = (await findEncounter(tx, bill.encounterId))!;
    if (encounter.type === "IPD") bill = await fillIpdBill(tx, bill, actor);
    if ((await toBillDto(tx, bill)).items.length === 0) throw badRequest("There is nothing on this bill. Add the charges first (for example, set the ward bed charge).");
    await setBillStatus(tx, id, "finalized");
    await markBilled(tx, bill.encounterId);
    await recordAudit(tx, actor, "Bill Finalized", bill.billNo);
    return toBillDto(tx, { ...bill, status: "finalized" });
  });
}

export interface PayInput {
  mode: NonNullable<BillRow["paymentMode"]>;
  reference?: string | undefined;
  amountReceived?: number | undefined;
}

/**
 * finalized -> paid. For an admission the advances already paid come off first: what is left is collected as one settlement receipt, or,
 * if the advances were more than the bill, the difference is given back and recorded as a refund receipt.
 */
export async function markBillPaid(db: Database, id: string, actor: string, input: PayInput = { mode: "cash" }): Promise<BillDto> {
  return db.transaction(async (tx) => {
    const bill = await lockBill(tx, id);
    if (!bill) throw notFound("Bill");
    if (bill.kind === "opd_fee") throw conflict(`${bill.billNo} is an OPD consultation fee: collect it at OPD billing ("Collect payment")`);
    if (bill.status !== "finalized") throw conflict(`Only a finalized bill can be paid (this one is ${bill.status})`);

    const encounter = (await findEncounter(tx, bill.encounterId))!;
    if (encounter.type === "IPD") {
      const total = (await toBillDto(tx, bill)).total;
      const held = advancesHeld(await listPayments(tx, encounter.id));
      const net = round2(total - held);
      if (net !== 0) requireReference(input.mode, input.reference);
      if (net > 0) {
        if (input.mode === "cash" && input.amountReceived !== undefined && input.amountReceived < net) throw badRequest("The cash received is less than the amount due");
        const receipt = await insertPayment(tx, encounter, "settlement", { amount: net, mode: input.mode, reference: input.reference }, actor, id);
        await recordAudit(tx, actor, "IPD Bill Settled", `${bill.billNo}: ${receipt.receiptNo} Rs ${net} (${input.mode}) after advances Rs ${held}`);
      } else if (net < 0) {
        const receipt = await insertPayment(tx, encounter, "refund", { amount: -net, mode: input.mode, reference: input.reference, note: "Advance more than the bill" }, actor, id);
        await recordAudit(tx, actor, "IPD Bill Settled With Refund", `${bill.billNo}: ${receipt.receiptNo} Rs ${-net} refunded (${input.mode})`);
      } else {
        await recordAudit(tx, actor, "IPD Bill Settled", `${bill.billNo}: advances covered the bill`);
      }
    }
    await payBill(tx, id, input.mode);
    await recordAudit(tx, actor, "Bill Paid", bill.billNo);
    return toBillDto(tx, (await findBill(tx, id))!);
  });
}

/** The admission's final bill: made (or refreshed) after discharge, optionally with a discount. Billing counter and administrators. */
export async function prepareFinalBill(db: Database, encounterId: string, discount: DiscountInput | null | undefined, actor: string): Promise<BillDto> {
  return db.transaction(async (tx) => {
    const encounter = await findEncounter(tx, encounterId);
    if (!encounter) throw notFound("Admission");
    if (encounter.type !== "IPD") throw badRequest("This is not an inpatient admission");
    if (encounter.status === "admitted") throw conflict("The final bill is made after the patient is discharged. Until then, use the running bill.");
    const bill = await generateBillForEncounter(tx, encounterId, actor);
    if (!bill) throw badRequest("There is nothing to bill for this admission");
    if (discount !== undefined) return applyDiscountIn(tx, bill.id, discount, actor);
    return bill;
  });
}

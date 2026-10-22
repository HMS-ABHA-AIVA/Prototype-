import type { Database, Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { closeBedStay, lockBed, logHousekeeping, occupyBed, openBedStay, releaseBed, type BedRow } from "../beds/beds.repository.js";
import { createOpdFeeBill, generateBillForEncounter } from "../billing/billing.service.js";
import { findInvestigation, findInvestigationByName } from "../masters/investigations.js";
import { findPanel } from "../panels/panels.js";
import { findPatient } from "../patients/patients.repository.js";
import { findStaff } from "../staff/staff.js";
import type {
  AdmitDirectInput, AdmitFromInput, CheckInErInput, CheckInOpdInput, ErDispositionInput, OrderInput, PrescriptionInput, SoapInput, TransferBedInput, VitalsInput,
} from "./encounters.schemas.js";
import {
  findEncounter, insertEncounter, insertOrder, insertPrescription, insertVitals, listEncounters, listOrdersForMany, listPrescriptionsForMany, listVitalsForMany,
  lockEncounter, markAdmitted, markBilled, markDischarged, resolveEmergency, saveSoap, setEncounterBed, setStatus, setTriage, type EncounterRow, type TriageLevel,
} from "./encounters.repository.js";

// ---- shapes returned to the API --------------------------------------------------------------

/** The encounter with its consultation note grouped, plus everything recorded during the visit. */
export async function toEncounterDetails(db: Queryable, rows: EncounterRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [vitals, prescriptions, orders] = await Promise.all([listVitalsForMany(db, ids), listPrescriptionsForMany(db, ids), listOrdersForMany(db, ids)]);
  const group = <T extends { encounterId: string }>(items: T[]) => {
    const by = new Map<string, T[]>();
    for (const item of items) by.set(item.encounterId, [...(by.get(item.encounterId) ?? []), item]);
    return by;
  };
  const vitalsBy = group(vitals);
  const rxBy = group(prescriptions);
  const ordersBy = group(orders);

  return rows.map((row) => {
    const { soapSubjective, soapObjective, soapAssessment, soapPlan, ...rest } = row;
    const hasNote = [soapSubjective, soapObjective, soapAssessment, soapPlan].some((v) => v !== null);
    return {
      ...rest,
      soap: hasNote ? { subjective: soapSubjective ?? "", objective: soapObjective ?? "", assessment: soapAssessment ?? "", plan: soapPlan ?? "" } : null,
      vitals: vitalsBy.get(row.id) ?? [],
      prescriptions: rxBy.get(row.id) ?? [],
      orders: ordersBy.get(row.id) ?? [],
    };
  });
}

export const toEncounterDetail = async (db: Queryable, row: EncounterRow) => (await toEncounterDetails(db, [row]))[0]!;
export type EncounterDetail = Awaited<ReturnType<typeof toEncounterDetail>>;

/** True while the visit is still open for clinical entries. (An ER visit that led to admission is finished; the IPD one continues.) */
export function isActive(e: EncounterRow): boolean {
  if (e.type === "IPD") return e.status === "admitted";
  if (e.type === "ER") return e.status === "in_er";
  return e.status === "waiting" || e.status === "in_consult";
}

async function requireActive(db: Queryable, id: string): Promise<EncounterRow> {
  const encounter = await lockEncounter(db, id);
  if (!encounter) throw notFound("Encounter");
  if (!isActive(encounter)) throw conflict(`This ${encounter.type} encounter is already ${encounter.status} and can no longer be changed`);
  return encounter;
}

async function requireDoctor(db: Queryable, doctorId: string) {
  const doctor = await findStaff(db, doctorId);
  if (!doctor || doctor.role !== "doctor") throw badRequest("doctorId must be an existing doctor");
  return doctor;
}

async function requirePatient(db: Queryable, patientId: string) {
  const patient = await findPatient(db, patientId);
  if (!patient) throw notFound("Patient");
  return patient;
}

// ---- reading ---------------------------------------------------------------------------------

export const listEncounterRows = (db: Database, filters: Parameters<typeof listEncounters>[1]) => listEncounters(db, filters);

/** The same list, with each visit's note, vitals, prescriptions and orders attached. */
export async function listEncounterDetails(db: Database, filters: Parameters<typeof listEncounters>[1]): Promise<EncounterDetail[]> {
  return toEncounterDetails(db, await listEncounters(db, filters));
}

export async function getEncounterDetail(db: Database, id: string): Promise<EncounterDetail> {
  const row = await findEncounter(db, id);
  if (!row) throw notFound("Encounter");
  return toEncounterDetail(db, row);
}

// ---- starting visits -------------------------------------------------------------------------

/**
 * Opens one OPD consultation (one patient, one doctor) and sends it to OPD billing: the visit starts as 'awaiting_payment' with no
 * token, and a consultation-fee bill is raised at that doctor's fee. The token (and a place in that doctor's queue) is only issued when the
 * fee is collected (see the opd-billing module). A patient may have consultations with several doctors in the same day, one per department.
 */
export async function openOpdVisit(tx: Queryable, input: CheckInOpdInput, actor: string): Promise<EncounterRow> {
  const patient = await requirePatient(tx, input.patientId);
  const doctor = await requireDoctor(tx, input.doctorId);
  const open = await tx.queryOne<{ id: string }>(
    `SELECT id FROM "Encounter"
      WHERE "facilityId" = :fid AND "patientId" = $1 AND type = 'OPD' AND department = $2 AND status IN ('awaiting_payment','waiting','in_consult') LIMIT 1`,
    [input.patientId, input.department],
  );
  if (open) throw conflict(`${patient.name} already has an open ${input.department} OPD visit (awaiting billing, in the queue, or in consultation)`);
  const row = (await insertEncounter(tx, {
    patientId: input.patientId, type: "OPD", status: "awaiting_payment", doctorId: input.doctorId, department: input.department,
  }))!;
  await createOpdFeeBill(tx, row.id, input.patientId, { doctorName: doctor.name, department: input.department, fee: doctor.opdFee }, actor);
  await recordAudit(tx, actor, "OPD Registered, Awaiting Billing", `${patient.name} - ${input.department} (${doctor.name})`);
  return row;
}

export async function checkInOpd(db: Database, input: CheckInOpdInput, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => toEncounterDetail(tx, await openOpdVisit(tx, input, actor)));
}

export async function startConsult(db: Database, id: string, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "OPD") throw badRequest("Only OPD encounters have a consultation to start");
    await setStatus(tx, id, "in_consult");
    await recordAudit(tx, actor, "Consultation Started", id);
    return toEncounterDetail(tx, (await findEncounter(tx, id))!);
  });
}

export async function checkInEr(db: Database, input: CheckInErInput, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    const patient = await requirePatient(tx, input.patientId);
    await requireDoctor(tx, input.doctorId);
    const row = (await insertEncounter(tx, {
      patientId: input.patientId, type: "ER", status: "in_er", doctorId: input.doctorId, department: "Emergency",
      chiefComplaint: input.chiefComplaint, triageLevel: input.triageLevel, arrivalMode: input.arrivalMode,
    }))!;
    await recordAudit(tx, actor, "ER Check-in", `${patient.name}: ${input.chiefComplaint} - triage ${input.triageLevel.toUpperCase()}`);
    return toEncounterDetail(tx, row);
  });
}

// ---- recording care --------------------------------------------------------------------------

export async function saveSoapNote(db: Database, id: string, soap: SoapInput, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    await requireActive(tx, id);
    await saveSoap(tx, id, soap);
    await recordAudit(tx, actor, "SOAP Note Saved", id);
    return toEncounterDetail(tx, (await findEncounter(tx, id))!);
  });
}

export async function addVitals(db: Database, id: string, vitals: VitalsInput, actor: string) {
  return db.transaction(async (tx) => {
    await requireActive(tx, id);
    const row = await insertVitals(tx, id, vitals);
    await recordAudit(tx, actor, "Vitals Recorded", [vitals.bp && `BP ${vitals.bp}`, vitals.spo2 && `SpO2 ${vitals.spo2}%`].filter(Boolean).join(", "));
    return row;
  });
}

export async function addPrescription(db: Database, id: string, rx: Omit<PrescriptionInput, "aiSuggested"> & { aiSuggested?: boolean }, actor: string) {
  return db.transaction(async (tx) => {
    await requireActive(tx, id);
    const row = await insertPrescription(tx, id, rx);
    await recordAudit(tx, actor, "Prescription Added", `${rx.drugName} - ${rx.dose} ${rx.frequency}${rx.aiSuggested ? " (AI-suggested, reviewed by the doctor)" : ""}`);
    return row;
  });
}

export async function addOrder(db: Database, id: string, order: OrderInput, actor: string) {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    // The order is priced from the hospital's test list: the one picked, or the one whose name was typed. Anything else is "unlisted".
    const test = order.investigationId ? await findInvestigation(tx, order.investigationId) : await findInvestigationByName(tx, order.name);
    if (order.investigationId && (!test || !test.active)) throw badRequest("That test is not on the hospital's list");
    if (test && test.kind !== order.type) throw badRequest(`${test.name} is a ${test.kind} test`);
    const row = await insertOrder(tx, id, encounter.patientId, { type: order.type, name: test?.name ?? order.name, investigationId: test?.id ?? null });
    await recordAudit(tx, actor, "Order Placed", `${order.type.toUpperCase()}: ${test?.name ?? order.name}`);
    return row;
  });
}

export async function changeTriage(db: Database, id: string, level: TriageLevel, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "ER") throw badRequest("Only emergency encounters have a triage level");
    await setTriage(tx, id, level);
    await recordAudit(tx, actor, "ER Triage Updated", `${id} -> ${level.toUpperCase()}`);
    return toEncounterDetail(tx, (await findEncounter(tx, id))!);
  });
}

// ---- finishing visits ------------------------------------------------------------------------

/**
 * OPD consultation is over: close it. Anything beyond the consultation fee that was already collected at OPD billing (tests ordered,
 * medicines dispensed) goes on a second bill; if there is nothing more to charge the visit is simply complete and `bill` is null.
 */
export async function closeOpd(db: Database, id: string, actor: string) {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "OPD") throw badRequest("Only OPD encounters are closed this way");
    await setStatus(tx, id, "closed");
    await recordAudit(tx, actor, "Consultation Closed", id);
    const bill = await generateBillForEncounter(tx, id, actor);
    if (!bill) await markBilled(tx, id); // the consultation fee was the whole bill and it is already paid
    return { encounter: await toEncounterDetail(tx, (await findEncounter(tx, id))!), bill };
  });
}

/** An emergency case ends: discharged, referred elsewhere, left against advice, or deceased. The ER visit is billed. */
export async function resolveEr(db: Database, id: string, input: ErDispositionInput, actor: string) {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "ER") throw badRequest("Only emergency encounters have an ER disposition");
    await resolveEmergency(tx, id, input.disposition, input.note, input.referredTo ?? null);
    const labels = { discharged: "ER Patient Discharged", referred: "ER Patient Referred Out", lama: "ER Patient Left Against Medical Advice", deceased: "ER Patient Deceased" };
    await recordAudit(tx, actor, labels[input.disposition], input.referredTo ? `${input.note} - referred to ${input.referredTo}` : input.note);
    const bill = await generateBillForEncounter(tx, id, actor);
    return { encounter: await toEncounterDetail(tx, (await findEncounter(tx, id))!), bill };
  });
}

// ---- admission and discharge -----------------------------------------------------------------

/** A bed can be taken when it is vacant, or reserved for this patient (or a reservation that has lapsed). */
function bedIsTakeable(bed: BedRow, patientId: string): boolean {
  if (bed.status === "vacant") return true;
  if (bed.status !== "reserved") return false;
  return bed.reservedPatientId === patientId || (!!bed.reservedUntil && new Date(bed.reservedUntil) < new Date());
}
const unavailable = (bed: BedRow) =>
  conflict(bed.status === "reserved" ? `Bed ${bed.ward} ${bed.bedNo} is reserved for ${bed.reservedFor ?? "another patient"}` : `Bed ${bed.ward} ${bed.bedNo} is ${bed.status}, not vacant`);

/** The panel an admission is billed under: it must exist and be active, and say the card number if the panel needs one. */
async function checkedPanel(tx: Queryable, panelId: string | null | undefined, beneficiaryId: string | undefined) {
  if (!panelId) return { panelId: null, beneficiaryId: null };
  const panel = await findPanel(tx, panelId);
  if (!panel || !panel.active) throw badRequest("That billing category is not available");
  if (panel.requiresBeneficiaryId && !beneficiaryId?.trim()) throw badRequest(`Enter the ${panel.code} beneficiary / card number`);
  return { panelId, beneficiaryId: beneficiaryId?.trim() || null };
}

/** Puts a patient in a vacant bed under a new IPD encounter. Locks the bed so nobody else can take it. */
async function admitToBed(
  tx: Queryable,
  a: { patientId: string; department: string; doctorId: string; bedId: string; linkedEncounterId?: string; panelId?: string | null | undefined; beneficiaryId?: string | undefined },
  actor: string,
): Promise<EncounterRow> {
  await requireDoctor(tx, a.doctorId);
  const bed = await lockBed(tx, a.bedId);
  if (!bed) throw notFound("Bed");
  if (!bedIsTakeable(bed, a.patientId)) throw unavailable(bed);
  const billing = await checkedPanel(tx, a.panelId, a.beneficiaryId);

  const admittedAt = new Date();
  const ipd = (await insertEncounter(tx, {
    patientId: a.patientId, type: "IPD", status: "admitted", doctorId: a.doctorId, department: a.department,
    bedId: a.bedId, admittedAt, linkedEncounterId: a.linkedEncounterId ?? null, ...billing,
  }))!;
  await occupyBed(tx, a.bedId, a.patientId, ipd.id);
  await openBedStay(tx, ipd.id, bed, admittedAt);
  await recordAudit(tx, actor, "Patient Admitted", `${bed.ward} ${bed.bedNo} - ${a.department}`);
  return ipd;
}

export async function admitDirect(db: Database, input: AdmitDirectInput, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    await requirePatient(tx, input.patientId);
    return toEncounterDetail(tx, await admitToBed(tx, input, actor));
  });
}

/**
 * Admits the patient of an open OPD or ER visit. The two encounters are linked to each other, the original
 * visit is closed as "admitted" and billed on its own, and the inpatient stay starts a new encounter.
 */
export async function admitFromEncounter(db: Database, sourceId: string, input: AdmitFromInput, actor: string) {
  return db.transaction(async (tx) => {
    const source = await requireActive(tx, sourceId);
    if (source.type === "IPD") throw badRequest("This patient is already admitted");
    const ipd = await admitToBed(tx, { ...input, patientId: source.patientId, linkedEncounterId: source.id }, actor);
    await markAdmitted(tx, source.id, ipd.id);
    await recordAudit(tx, actor, `${source.type} Patient Admitted to IPD`, `${source.id} -> ${ipd.id}`);
    const bill = await generateBillForEncounter(tx, source.id, actor);
    return {
      admission: await toEncounterDetail(tx, ipd),
      source: await toEncounterDetail(tx, (await findEncounter(tx, source.id))!),
      bill,
    };
  });
}

/**
 * Moves an admitted patient to a vacant bed. The new bed is taken straight away; the old one becomes "dirty" and goes
 * to housekeeping (and the move is written to the housekeeping log).
 */
export async function transferBed(db: Database, id: string, input: TransferBedInput, actor: string): Promise<EncounterDetail> {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "IPD" || !encounter.bedId) throw badRequest("Only an admitted inpatient can be moved to another bed");
    if (encounter.bedId === input.bedId) throw badRequest("The patient is already in that bed");

    // Lock both beds in a fixed order so two simultaneous transfers cannot deadlock each other.
    const [firstId, secondId] = [encounter.bedId, input.bedId].sort();
    await lockBed(tx, firstId!);
    await lockBed(tx, secondId!);
    const target = await lockBed(tx, input.bedId);
    if (!target) throw notFound("Bed");
    if (!bedIsTakeable(target, encounter.patientId)) throw unavailable(target);

    const movedAt = new Date();
    await closeBedStay(tx, id, movedAt);
    await openBedStay(tx, id, target, movedAt);
    await occupyBed(tx, input.bedId, encounter.patientId, id);
    await releaseBed(tx, encounter.bedId);
    await logHousekeeping(tx, encounter.bedId, "discharge_release", actor);
    await setEncounterBed(tx, id, input.bedId);
    await recordAudit(tx, actor, "Bed Transfer", `${encounter.bedId} -> ${input.bedId}`);
    return toEncounterDetail(tx, (await findEncounter(tx, id))!);
  });
}

/** Discharge: records the summary, frees the bed for housekeeping (it becomes "dirty") and raises the bill. */
export async function dischargeIpd(db: Database, id: string, summary: string, actor: string) {
  return db.transaction(async (tx) => {
    const encounter = await requireActive(tx, id);
    if (encounter.type !== "IPD") throw badRequest("Only inpatient encounters are discharged this way");
    await markDischarged(tx, id, summary);
    await closeBedStay(tx, id);
    if (encounter.bedId) {
      await releaseBed(tx, encounter.bedId);
      await logHousekeeping(tx, encounter.bedId, "discharge_release", actor);
    }
    await recordAudit(tx, actor, "Discharge Summary Signed Off", id);
    if (encounter.bedId) await recordAudit(tx, actor, "Bed Released for Housekeeping", `bed ${encounter.bedId}`);
    const bill = await generateBillForEncounter(tx, id, actor);
    return { encounter: await toEncounterDetail(tx, (await findEncounter(tx, id))!), bill };
  });
}

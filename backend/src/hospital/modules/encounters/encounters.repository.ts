import type { Queryable } from "../../db.js";

export type EncounterType = "OPD" | "IPD" | "ER";
export type EncounterStatus =
  | "awaiting_payment" | "waiting" | "in_consult" | "in_er" | "admitted" | "discharged" | "referred" | "lama" | "deceased" | "billed" | "closed" | "cancelled";
export type TriageLevel = "red" | "yellow" | "green" | "black";

export interface EncounterRow {
  id: string;
  patientId: string;
  type: EncounterType;
  status: EncounterStatus;
  doctorId: string | null;
  department: string;
  tokenNo: number | null;
  bedId: string | null;
  admittedAt: string | null;
  chiefComplaint: string | null;
  triageLevel: TriageLevel | null;
  arrivalMode: "walk_in" | "ambulance" | "referred_in" | null;
  dispositionNote: string | null;
  referredTo: string | null;
  linkedEncounterId: string | null;
  soapSubjective: string | null;
  soapObjective: string | null;
  soapAssessment: string | null;
  soapPlan: string | null;
  dischargeSummary: string | null;
  billed: boolean;
  /** The panel (CGHS, DGHS ...) an inpatient stay is billed under, and the patient's card number with it. */
  panelId: string | null;
  beneficiaryId: string | null;
  dischargedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VitalRow {
  id: string;
  encounterId: string;
  takenAt: string;
  tempF: number | null;
  pulse: number | null;
  bp: string | null;
  spo2: number | null;
  rr: number | null;
}
export interface PrescriptionRow {
  id: string;
  encounterId: string;
  drugName: string;
  dose: string;
  frequency: string;
  duration: string;
  dispensed: boolean;
  aiSuggested: boolean;
  createdAt: string;
}
export type OrderStatus = "ordered" | "sample_collected" | "in_progress" | "resulted" | "completed" | "cancelled";
/** An order as the visit sees it. `accessionNo`, `critical` and `signedAt` say how far the lab has got (see modules/lab). */
export interface OrderRow {
  id: string;
  encounterId: string;
  type: "lab" | "radiology";
  name: string;
  status: OrderStatus;
  investigationId: string | null;
  createdAt: string;
  accessionNo: string | null;
  critical: boolean;
  criticalAckAt: string | null;
  signedAt: string | null;
}

const COLUMNS = `id, "patientId", type, status, "doctorId", department, "tokenNo", "bedId", "admittedAt", "chiefComplaint", "triageLevel",
  "arrivalMode", "dispositionNote", "referredTo", "linkedEncounterId", "soapSubjective", "soapObjective", "soapAssessment", "soapPlan",
  "dischargeSummary", billed, "panelId", "beneficiaryId", "dischargedAt", "createdAt", "updatedAt"`;

// ---- encounters ------------------------------------------------------------------------------

export function insertEncounter(
  db: Queryable,
  e: {
    patientId: string;
    type: EncounterType;
    status: EncounterStatus;
    doctorId: string | null;
    department: string;
    tokenNo?: number | null;
    bedId?: string | null;
    admittedAt?: Date | null;
    chiefComplaint?: string | null;
    triageLevel?: TriageLevel | null;
    arrivalMode?: string | null;
    linkedEncounterId?: string | null;
    panelId?: string | null;
    beneficiaryId?: string | null;
  },
) {
  return db.queryOne<EncounterRow>(
    `INSERT INTO "Encounter" ("facilityId", "patientId", type, status, "doctorId", department, "tokenNo", "tokenIssuedOn", "bedId", "admittedAt", "chiefComplaint",
                             "triageLevel", "arrivalMode", "linkedEncounterId", "panelId", "beneficiaryId")
     VALUES (:fid, $1,$2,$3,$4,$5,$6, CASE WHEN $6::int IS NULL THEN NULL ELSE (now() AT TIME ZONE 'Asia/Kolkata')::date END, $7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${COLUMNS}`,
    [
      e.patientId, e.type, e.status, e.doctorId, e.department, e.tokenNo ?? null, e.bedId ?? null, e.admittedAt?.toISOString() ?? null,
      e.chiefComplaint ?? null, e.triageLevel ?? null, e.arrivalMode ?? null, e.linkedEncounterId ?? null, e.panelId ?? null, e.beneficiaryId ?? null,
    ],
  );
}

/** Next OPD queue token for a department today (1, 2, 3 …), by Indian calendar day. Counted by the day tokens were issued (at payment), not the day the visit was created. */
export async function nextTokenNo(db: Queryable, department: string): Promise<number> {
  const row = await db.queryOne<{ n: number }>(
    `SELECT COALESCE(max("tokenNo"), 0) + 1 AS n FROM "Encounter"
      WHERE "facilityId" = :fid AND type = 'OPD' AND department = $1 AND "tokenNo" IS NOT NULL AND "tokenIssuedOn" = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [department],
  );
  return row!.n;
}

export const findEncounter = (db: Queryable, id: string) =>
  db.queryOne<EncounterRow>(`SELECT ${COLUMNS} FROM "Encounter" WHERE "facilityId" = :fid AND id = $1`, [id]);

/** Same as findEncounter but locks the row until the transaction ends, so two requests cannot both change it. */
export const lockEncounter = (db: Queryable, id: string) =>
  db.queryOne<EncounterRow>(`SELECT ${COLUMNS} FROM "Encounter" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`, [id]);

export function listEncounters(db: Queryable, f: { type?: string | undefined; status?: string | undefined; patientId?: string | undefined; limit: number }) {
  return db.query<EncounterRow>(
    `SELECT ${COLUMNS} FROM "Encounter"
      WHERE "facilityId" = :fid AND ($1::text IS NULL OR type = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR "patientId" = $3)
      ORDER BY "createdAt" DESC LIMIT $4`,
    [f.type ?? null, f.status ?? null, f.patientId ?? null, f.limit],
  );
}

/** The consultation fee has been paid: hand out the token and put the visit in the OPD queue. */
export const issueToken = (db: Queryable, id: string, tokenNo: number) =>
  db.execute(
    `UPDATE "Encounter" SET status = 'waiting', "tokenNo" = $2, "tokenIssuedOn" = (now() AT TIME ZONE 'Asia/Kolkata')::date, "updatedAt" = now()
      WHERE "facilityId" = :fid AND id = $1`,
    [id, tokenNo],
  );

export const setStatus = (db: Queryable, id: string, status: EncounterStatus) =>
  db.execute('UPDATE "Encounter" SET status = $2, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [id, status]);

export const saveSoap = (db: Queryable, id: string, s: { subjective: string; objective: string; assessment: string; plan: string }) =>
  db.execute(
    `UPDATE "Encounter" SET "soapSubjective"=$2, "soapObjective"=$3, "soapAssessment"=$4, "soapPlan"=$5, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1`,
    [id, s.subjective, s.objective, s.assessment, s.plan],
  );

export const setTriage = (db: Queryable, id: string, level: TriageLevel) =>
  db.execute('UPDATE "Encounter" SET "triageLevel" = $2, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [id, level]);

export const resolveEmergency = (db: Queryable, id: string, status: EncounterStatus, note: string, referredTo: string | null) =>
  db.execute(
    'UPDATE "Encounter" SET status=$2, "dispositionNote"=$3, "referredTo"=$4, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1',
    [id, status, note, referredTo],
  );

export const markAdmitted = (db: Queryable, id: string, linkedEncounterId: string) =>
  db.execute(`UPDATE "Encounter" SET status='admitted', "linkedEncounterId"=$2, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1`, [id, linkedEncounterId]);

export const setEncounterBed = (db: Queryable, id: string, bedId: string) =>
  db.execute('UPDATE "Encounter" SET "bedId" = $2, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [id, bedId]);

export const markDischarged = (db: Queryable, id: string, summary: string) =>
  db.execute(
    `UPDATE "Encounter" SET status='discharged', "dischargeSummary"=$2, "dischargedAt" = now(), "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1`,
    [id, summary],
  );

/** What an inpatient stay is billed under (null = self-pay). */
export const setBillingCategory = (db: Queryable, id: string, panelId: string | null, beneficiaryId: string | null) =>
  db.execute('UPDATE "Encounter" SET "panelId" = $2, "beneficiaryId" = $3, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [id, panelId, beneficiaryId]);

export const markBilled = (db: Queryable, id: string) =>
  db.execute('UPDATE "Encounter" SET billed = true, "updatedAt" = now() WHERE "facilityId" = :fid AND id = $1', [id]);

// ---- vitals ----------------------------------------------------------------------------------

const VITAL_COLUMNS = 'id, "encounterId", "takenAt", "tempF", pulse, bp, spo2, rr';

export const insertVitals = (
  db: Queryable,
  encounterId: string,
  v: { tempF?: number | undefined; pulse?: number | undefined; bp?: string | undefined; spo2?: number | undefined; rr?: number | undefined },
) =>
  db.queryOne<VitalRow>(
    `INSERT INTO "Vital" ("facilityId", "encounterId", "tempF", pulse, bp, spo2, rr) VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING ${VITAL_COLUMNS}`,
    [encounterId, v.tempF ?? null, v.pulse ?? null, v.bp ?? null, v.spo2 ?? null, v.rr ?? null],
  );

export const listVitals = (db: Queryable, encounterId: string) =>
  db.query<VitalRow>(`SELECT ${VITAL_COLUMNS} FROM "Vital" WHERE "facilityId" = :fid AND "encounterId" = $1 ORDER BY "takenAt"`, [encounterId]);

// Several encounters at once (one query each instead of one per visit; matters when the database is far away).
export const listVitalsForMany = (db: Queryable, ids: string[]) =>
  db.query<VitalRow>(`SELECT ${VITAL_COLUMNS} FROM "Vital" WHERE "facilityId" = :fid AND "encounterId" = ANY($1::text[]) ORDER BY "takenAt"`, [ids]);

// ---- prescriptions ---------------------------------------------------------------------------

const RX_COLUMNS = 'id, "encounterId", "drugName", dose, frequency, duration, dispensed, "aiSuggested", "createdAt"';

export const insertPrescription = (
  db: Queryable,
  encounterId: string,
  p: { drugName: string; dose: string; frequency: string; duration: string; aiSuggested?: boolean | undefined },
) =>
  db.queryOne<PrescriptionRow>(
    `INSERT INTO "Prescription" ("facilityId", "encounterId", "drugName", dose, frequency, duration, "aiSuggested") VALUES (:fid, $1,$2,$3,$4,$5,$6)
     RETURNING ${RX_COLUMNS}`,
    [encounterId, p.drugName, p.dose, p.frequency, p.duration, p.aiSuggested ?? false],
  );

export const listPrescriptionsForMany = (db: Queryable, ids: string[]) =>
  db.query<PrescriptionRow>(`SELECT ${RX_COLUMNS} FROM "Prescription" WHERE "facilityId" = :fid AND "encounterId" = ANY($1::text[]) ORDER BY "createdAt"`, [ids]);

export const listPrescriptions = (db: Queryable, encounterId: string) =>
  db.query<PrescriptionRow>(`SELECT ${RX_COLUMNS} FROM "Prescription" WHERE "facilityId" = :fid AND "encounterId" = $1 ORDER BY "createdAt"`, [encounterId]);

// ---- orders ----------------------------------------------------------------------------------

const ORDER_COLUMNS = 'id, "encounterId", type, name, status, "investigationId", "createdAt", "accessionNo", critical, "criticalAckAt", "signedAt"';

export const insertOrder = (db: Queryable, encounterId: string, patientId: string, o: { type: "lab" | "radiology"; name: string; investigationId?: string | null }) =>
  db.queryOne<OrderRow>(
    `INSERT INTO "ClinicalOrder" ("facilityId", "encounterId", "patientId", type, name, "investigationId") VALUES (:fid, $1,$2,$3,$4,$5) RETURNING ${ORDER_COLUMNS}`,
    [encounterId, patientId, o.type, o.name, o.investigationId ?? null],
  );

/** Every order of the visits, cancelled ones included (the screens show them struck off). */
export const listOrdersForMany = (db: Queryable, ids: string[]) =>
  db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM "ClinicalOrder" WHERE "facilityId" = :fid AND "encounterId" = ANY($1::text[]) ORDER BY "createdAt"`, [ids]);

/** The orders a visit is billed for: a cancelled test is not charged. */
export const listOrders = (db: Queryable, encounterId: string) =>
  db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM "ClinicalOrder" WHERE "facilityId" = :fid AND "encounterId" = $1 AND status <> 'cancelled' ORDER BY "createdAt"`, [
    encounterId,
  ]);

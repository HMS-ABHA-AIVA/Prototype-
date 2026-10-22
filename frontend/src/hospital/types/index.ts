export type Role = 'front_office' | 'doctor' | 'nurse' | 'pharmacist' | 'biller' | 'housekeeping' | 'lab' | 'admin';

export type Gender = 'M' | 'F' | 'O';

export interface Patient {
  id: string;
  mrn: string;
  name: string;
  age: number;
  gender: Gender;
  phone: string;
  abhaNumber?: string;
  abhaAddress?: string;
  abhaStatus: 'none' | 'pending' | 'linked';
  allergies: string[];
  problemList: string[];
  createdAt: string;
}

export type EncounterType = 'OPD' | 'IPD' | 'ER';
export type EncounterStatus =
  /** OPD: registered, consultation fee not yet collected (no token, not in the queue). */
  | 'awaiting_payment'
  | 'waiting'
  | 'in_consult'
  | 'in_er'
  | 'admitted'
  | 'discharged'
  | 'referred'
  | 'lama'
  | 'deceased'
  | 'billed'
  | 'closed'
  /** OPD visit abandoned before the fee was paid. */
  | 'cancelled';

/** Standard 4-color emergency triage scale: Red = immediate, Yellow = urgent, Green = non-urgent, Black = deceased/expectant. */
export type TriageLevel = 'red' | 'yellow' | 'green' | 'black';

export type ArrivalMode = 'walk_in' | 'ambulance' | 'referred_in';

export type ErDisposition = 'discharged' | 'referred' | 'lama' | 'deceased';

export interface VitalSet {
  takenAt: string;
  temp: number;
  pulse: number;
  bp: string;
  spo2: number;
  rr: number;
}

export interface SoapNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface Prescription {
  id: string;
  /** True when this line began as an AI suggestion that the doctor reviewed and chose to add. */
  aiSuggested?: boolean;
  drugName: string;
  dose: string;
  frequency: string;
  duration: string;
  dispensed: boolean;
}

export interface Order {
  id: string;
  type: 'lab' | 'radiology';
  name: string;
  status: 'ordered' | 'sample_collected' | 'in_progress' | 'resulted' | 'completed' | 'cancelled';
  /** The test on the hospital's list this order was priced from, when it was picked from the list. */
  investigationId?: string | null;
  /** Sample number (lab) or accession number (radiology), once the lab has started. */
  accessionNo?: string | null;
  /** A critical value was found, and whether a doctor has acknowledged it. */
  critical?: boolean;
  criticalAckAt?: string | null;
  signedAt?: string | null;
}

export interface Encounter {
  id: string;
  patientId: string;
  type: EncounterType;
  status: EncounterStatus;
  doctorId?: string;
  department: string;
  tokenNo?: number;
  bedId?: string;
  admittedAt?: string;
  createdAt: string;
  soap?: SoapNote;
  vitals: VitalSet[];
  prescriptions: Prescription[];
  orders: Order[];
  aiDischargeSummaryDraft?: string;
  dischargeSummary?: string;
  billed: boolean;

  // Emergency / urgent care fields (type: 'ER')
  chiefComplaint?: string;
  triageLevel?: TriageLevel;
  arrivalMode?: ArrivalMode;
  dispositionNote?: string;
  referredTo?: string;
  /** Links an ER encounter to the IPD encounter it was admitted into, or vice versa. */
  linkedEncounterId?: string;
}

/**
 * Bed turnover color code: occupied = blue, dirty = red (just vacated, awaiting
 * housekeeping), cleaning = yellow (in progress), vacant = green (clean & ready).
 */
export type BedStatus = 'occupied' | 'dirty' | 'cleaning' | 'vacant' | 'reserved';

/** What an admission is billed under: a panel (CGHS, DGHS ...) and the patient's card number with it. Empty means self-pay. */
export interface AdmissionBilling {
  panelId?: string | null;
  beneficiaryId?: string;
}

export interface Bed {
  id: string;
  ward: string;
  bedNo: string;
  status: BedStatus;
  patientId?: string;
  encounterId?: string;
  statusSince: string;
  /** For a reserved bed: who it is being kept for, until when, and why. */
  reservedPatientId?: string | null;
  reservedFor?: string | null;
  reservedUntil?: string | null;
  reservedNote?: string | null;
}

export interface HousekeepingLogEntry {
  id: string;
  bedId: string;
  action: 'discharge_release' | 'cleaning_started' | 'cleaning_completed';
  at: string;
  by: string;
}

export interface Drug {
  id: string;
  name: string;
  batch: string;
  expiry: string;
  stock: number;
  reorderLevel: number;
  unit: string;
  mrp: number;
  /** GST on the medicine, printed on the bill (most are 5% or 12%). */
  gstPct?: number;
}

export type SupplyCategory =
  | 'Surgical Consumables'
  | 'PPE'
  | 'Linen & Housekeeping'
  | 'Equipment'
  | 'Stationery & Admin'
  | 'Diagnostic Consumables';

export interface Supply {
  id: string;
  name: string;
  category: SupplyCategory;
  unit: string;
  stock: number;
  reorderLevel: number;
  location: string;
  lastRestockedAt: string;
}

export interface SupplyLogEntry {
  id: string;
  supplyId: string;
  type: 'issue' | 'restock';
  qty: number;
  department: string;
  at: string;
  by: string;
}

/**
 * Bio-medical waste color categories per CPCB's Bio-Medical Waste Management
 * Rules, 2016 (Schedule I) — the standard India color-coded segregation scheme.
 */
export type WasteCategory = 'yellow' | 'red' | 'white' | 'blue';

export type WasteStage = 'segregated' | 'stored' | 'pretreated' | 'disposed';

export interface WasteBatch {
  id: string;
  category: WasteCategory;
  department: string;
  weightKg: number;
  stage: WasteStage;
  segregatedAt: string;
  segregatedBy: string;
  storageLocation?: string;
  storedAt?: string;
  pretreatmentMethod?: string;
  pretreatedAt?: string;
  pretreatedBy?: string;
  disposalVendor?: string;
  manifestNo?: string;
  disposedAt?: string;
  disposedBy?: string;
}

export type EmploymentType = 'salaried' | 'visiting_fee';

export interface Staff {
  id: string;
  name: string;
  role: Role;
  department: string;
  hprId?: string;
  employmentType: EmploymentType;
  monthlySalary?: number;
  /** What the hospital pays a visiting doctor per consultation (payroll). Not what the patient pays. */
  feePerConsult?: number;
  /** What a patient pays to see this doctor, if set for this doctor (otherwise the hospital's standard OPD fee). */
  consultationFee?: number;
  /** What a patient pays to see this doctor: their own fee, or the standard OPD fee. Worked out by the server. */
  opdFee?: number;
  bankAccountLast4?: string;
  dateOfJoining: string;
}

export type AttendanceStatus = 'present' | 'absent' | 'leave' | 'half_day';

/** A hospital typically runs 3 daily shifts; staff can be marked for more than one on the same date (a double shift). */
export type Shift = 'morning' | 'evening' | 'night';

export interface AttendanceEntry {
  id: string;
  staffId: string;
  date: string;
  shift: Shift;
  status: AttendanceStatus;
}

/** A planned duty assignment — the schedule, as distinct from AttendanceEntry which records what actually happened. */
export interface RosterEntry {
  id: string;
  staffId: string;
  date: string;
  shift: Shift;
  department: string;
}

export interface PayrollLineItem {
  staffId: string;
  staffName: string;
  role: Role;
  employmentType: EmploymentType;
  daysPresent: number;
  doubleShiftDays: number;
  workingDays: number;
  consultCount: number;
  grossPay: number;
  deductions: number;
  netPay: number;
}

export type PayrollStatus = 'draft' | 'finalized' | 'paid';

export interface PayrollRun {
  id: string;
  month: string;
  generatedAt: string;
  generatedBy: string;
  status: PayrollStatus;
  lines: PayrollLineItem[];
}

export interface BillLineItem {
  label: string;
  qty: number;
  rate: number;
  gstPct: number;
}

export interface Bill {
  id: string;
  /** Printed bill number, e.g. BILL-1001 (assigned by the backend). */
  billNo?: string;
  /** OPD / IPD / ER, as reported by the backend. */
  encounterType?: EncounterType;
  encounterId: string;
  patientId: string;
  items: BillLineItem[];
  status: 'draft' | 'finalized' | 'paid' | 'void';
  /** 'opd_fee' = the consultation fee collected at OPD billing before the visit joins the queue; 'final' = tests, medicines, stays. */
  kind?: 'opd_fee' | 'final';
  paymentMode?: 'cash' | 'upi' | 'card' | 'other';
  paidAt?: string;
  /** The OPD billing payment (receipt) this fee was collected in. */
  paymentId?: string;
  /** For an OPD fee: the doctor's fee it was raised at, before any panel rate or discount. */
  standardFee?: number;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  user: string;
  action: string;
  detail: string;
}

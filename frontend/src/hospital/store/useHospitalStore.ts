import { create } from 'zustand';
import type { DashboardSummary, PharmacyQueueItem } from '../api/clinical';
import type { AwaitingOpdVisit, CancelDetails, ConsultationRequest, InvoiceFilter, OpdInvoice, OpdInvoiceList, Panel, PanelInput, PaymentDetails, PricingChoice, Quote } from '../api/opdBilling';
import { createRemoteActions } from './remoteActions';
import type {
  AdmissionBilling,
  ArrivalMode,
  AttendanceEntry,
  AttendanceStatus,
  AuditEntry,
  Bed,
  Bill,
  Drug,
  Encounter,
  ErDisposition,
  HousekeepingLogEntry,
  Order,
  PayrollRun,
  Patient,
  Prescription,
  Role,
  RosterEntry,
  Shift,
  SoapNote,
  Staff,
  Supply,
  SupplyLogEntry,
  TriageLevel,
  VitalSet,
  WasteBatch,
  WasteCategory,
} from '../types';

/**
 * The hospital screens' data: what the server last returned for each part (patients, visits, beds ...) and the actions that
 * change it. Every action asks the server to do the work and then refreshes from what it saved (see remoteActions.ts).
 */
export interface HospitalState {
  currentRole: Role;
  currentStaff: Staff;
  patients: Patient[];
  encounters: Encounter[];
  beds: Bed[];
  drugs: Drug[];
  supplies: Supply[];
  supplyLog: SupplyLogEntry[];
  housekeepingLog: HousekeepingLogEntry[];
  wasteBatches: WasteBatch[];
  staff: Staff[];
  bills: Bill[];
  auditLog: AuditEntry[];
  attendance: AttendanceEntry[];
  payrollRuns: PayrollRun[];
  roster: RosterEntry[];
  /** False when the signed-in role may not read attendance (only administrators can), so cross-checks are skipped. */
  attendanceAvailable: boolean;
  /** Prescriptions waiting at the pharmacy counter (backend mode; in demo mode the page derives them from visits). */
  pharmacyQueue: PharmacyQueueItem[];
  /** Headline counts from the server (backend mode). */
  dashboard: DashboardSummary | null;
  /** OPD visits registered but waiting for their consultation fee to be collected (they join the queue after payment). */
  opdBilling: AwaitingOpdVisit[];
  /** OPD invoices for the days chosen on the OPD Billing screen, with totals (from the server; worked out from `opdInvoiceLog` in demo mode). */
  opdInvoices: OpdInvoiceList | null;
  /** Panels (CGHS, DGHS ...) with their special rates. */
  panels: Panel[];

  // Loaders: fetch one slice from the server. A role that may not read a slice simply gets nothing back for it.
  loadStaff: () => Promise<void>;
  loadAudit: () => Promise<void>;
  loadAttendance: (month: string) => Promise<void>;
  loadPayrollRuns: () => Promise<void>;
  loadRoster: (from: string, to: string) => Promise<void>;
  loadPatients: () => Promise<void>;
  loadEncounters: () => Promise<void>;
  loadBeds: () => Promise<void>;
  loadHousekeepingLog: () => Promise<void>;
  loadDrugs: () => Promise<void>;
  loadBills: () => Promise<void>;
  loadPharmacyQueue: () => Promise<void>;
  loadDashboard: () => Promise<void>;
  /** Refreshes the list of OPD visits waiting at OPD billing. (Without a backend it is worked out from the demo data.) */
  loadOpdBilling: () => Promise<void>;
  /** Refreshes the OPD invoices for the days and filters given (today by default). */
  loadOpdInvoices: (filter?: InvoiceFilter) => Promise<void>;
  /** Refreshes the panels (CGHS, DGHS ...). */
  loadPanels: () => Promise<void>;
  loadSupplies: () => Promise<void>;
  loadSupplyLog: () => Promise<void>;
  loadWaste: () => Promise<void>;

  /** Adopt the person who signed in: their role drives the menus and the actions offered. */
  signInAs: (user: { id: string; name: string; role: Role; department: string }) => void;

  toggleRosterAssignment: (staffId: string, date: string, shift: Shift, department: string) => void;
  copyWeek: (fromStartDate: string, toStartDate: string) => number | Promise<number>;

  issueSupply: (supplyId: string, qty: number, department: string) => void;
  restockSupply: (supplyId: string, qty: number) => void;
  addSupply: (data: Omit<Supply, 'id' | 'lastRestockedAt'>) => void;

  addStaff: (data: Omit<Staff, 'id'>) => void;
  updatePayInfo: (staffId: string, data: Partial<Pick<Staff, 'employmentType' | 'monthlySalary' | 'feePerConsult' | 'consultationFee' | 'bankAccountLast4'>>) => void;
  markAttendance: (staffId: string, date: string, shift: Shift, status: AttendanceStatus) => void;
  generatePayrollRun: (month: string) => PayrollRun | null | Promise<PayrollRun | null>;
  /** Resolves false when the server refused the change, so the field can go back to the saved value. */
  updatePayrollLineDeduction: (runId: string, staffId: string, deductions: number) => void | Promise<boolean>;
  finalizePayrollRun: (runId: string) => void;
  markPayrollPaid: (runId: string) => void;

  startCleaning: (bedId: string) => void;
  completeCleaning: (bedId: string) => void;

  logSegregation: (category: WasteCategory, department: string, weightKg: number) => void;
  moveToStorage: (batchId: string, location: string) => void;
  pretreatBatch: (batchId: string, method: string) => void;
  disposeBatch: (batchId: string, vendor: string, manifestNo: string) => void;

  registerPatient: (data: Omit<Patient, 'id' | 'mrn' | 'createdAt' | 'abhaStatus'> & { abhaStatus: Patient['abhaStatus'] }) => Patient | null | Promise<Patient | null>;
  /** Records an ABHA that ABDM really issued or verified (via the backend), as opposed to createAbha's demo number. */
  applyAbha: (patientId: string, abha: { abhaNumber: string; abhaAddress: string | null }, how: 'created' | 'verified') => void;
  /**
   * Registers a patient for one or more doctors (one per speciality / department) and sends them to OPD billing without paying yet.
   * Each consultation has its own fee, and joins that doctor's queue (with its own token) once the fee is collected. All or none; null if refused.
   */
  registerConsultations: (patientId: string, consultations: ConsultationRequest[]) => Promise<Encounter[] | null>;
  /** What the doctors (or already registered fees) would cost at standard or panel rates and with a discount. Null if it cannot be priced. */
  quoteOpd: (input: PricingChoice & { consultations?: ConsultationRequest[]; billIds?: string[] }) => Promise<Quote | null>;
  /** OPD billing in one step: register for the doctors, price, take payment, issue tokens and slips. Resolves to the invoice, or null if refused. */
  createOpdInvoice: (input: { patientId: string; consultations: ConsultationRequest[]; details: PaymentDetails; pricing: PricingChoice }) => Promise<OpdInvoice | null>;
  /** Bills fees that were registered earlier (one payment, one invoice, a token and slip per doctor). */
  collectOpdPayment: (billIds: string[], details: PaymentDetails, pricing?: PricingChoice) => Promise<OpdInvoice | null>;
  /** Cancels a paid invoice with a refund (before any consultation on it has started). Billing counter and administrators only. */
  cancelOpdInvoice: (invoiceId: string, details: CancelDetails) => Promise<OpdInvoice | null>;
  /** The patient left without paying: the consultation is cancelled and no token is issued. */
  cancelOpdVisit: (billId: string) => Promise<boolean>;
  /** Administrators: add or change a panel. */
  savePanel: (input: PanelInput & { id?: string }) => Promise<Panel | null>;
  /** Administrators: replace a panel's rates for departments. */
  savePanelRates: (panelId: string, rates: Panel['rates']) => Promise<boolean>;

  checkInToEr: (patientId: string, chiefComplaint: string, triageLevel: TriageLevel, arrivalMode: ArrivalMode, doctorId: string) => Encounter | null | Promise<Encounter | null>;
  updateTriage: (encounterId: string, triageLevel: TriageLevel) => void;
  resolveErEncounter: (encounterId: string, disposition: ErDisposition, note: string, referredTo?: string) => void | Promise<boolean>;
  linkAdmission: (sourceEncounterId: string, newEncounterId: string) => void;

  startConsult: (encounterId: string) => void;
  /** The ones that return a promise resolve false when the server refused, so a screen can stop instead of moving on. */
  saveSoapNote: (encounterId: string, soap: SoapNote) => void | Promise<boolean>;
  addVitals: (encounterId: string, vitals: Omit<VitalSet, 'takenAt'>) => void;
  addPrescription: (encounterId: string, rx: Omit<Prescription, 'id' | 'dispensed'>) => void;
  addOrder: (encounterId: string, order: Omit<Order, 'id' | 'status'>) => void;
  closeConsult: (encounterId: string) => void | Promise<boolean>;

  admitPatient: (patientId: string, department: string, doctorId: string, bedId: string, billing?: AdmissionBilling) => Encounter | null | Promise<Encounter | null>;
  /** Backend mode: admit from an OPD/ER visit in one step; the server closes that visit as admitted and bills it. */
  admitFromEncounter: (sourceEncounterId: string, department: string, doctorId: string, bedId: string, billing?: AdmissionBilling) => Promise<Encounter | null>;
  transferBed: (encounterId: string, newBedId: string) => void;
  generateDischargeDraft: (encounterId: string) => void;
  acceptDischargeSummary: (encounterId: string, finalText: string) => void | Promise<boolean>;

  dispensePrescription: (encounterId: string, rxId: string) => void;

  generateBill: (encounterId: string) => Bill | void;
  markBillPaid: (billId: string) => void;
  finalizeBill: (billId: string) => void;
}


type DataKeys =
  | 'currentRole' | 'currentStaff' | 'patients' | 'encounters' | 'beds' | 'drugs' | 'supplies' | 'supplyLog' | 'housekeepingLog' | 'wasteBatches'
  | 'staff' | 'bills' | 'auditLog' | 'attendance' | 'payrollRuns' | 'roster' | 'attendanceAvailable' | 'pharmacyQueue' | 'dashboard' | 'opdBilling'
  | 'opdInvoices' | 'panels';
export type ServerActions = Omit<HospitalState, DataKeys | 'signInAs'>;

/** Until the signed-in person is adopted (signInAs, straight after sign-in). */
const NOBODY: Staff = { id: '', name: '', role: 'front_office', department: '', employmentType: 'salaried', dateOfJoining: '' };

export const useHospitalStore = create<HospitalState>((set, get) => ({
  currentRole: 'front_office',
  currentStaff: NOBODY,
  patients: [],
  encounters: [],
  beds: [],
  drugs: [],
  supplies: [],
  supplyLog: [],
  housekeepingLog: [],
  wasteBatches: [],
  staff: [],
  bills: [],
  auditLog: [],
  attendance: [],
  payrollRuns: [],
  roster: [],
  attendanceAvailable: true,
  pharmacyQueue: [],
  dashboard: null,
  opdBilling: [],
  opdInvoices: null,
  panels: [],

  signInAs: (user) => {
    const known = get().staff.find((s) => s.id === user.id);
    const staffMember: Staff = known ?? {
      id: user.id, name: user.name, role: user.role, department: user.department,
      employmentType: 'salaried', dateOfJoining: new Date().toISOString().slice(0, 10),
    };
    set({ currentRole: user.role, currentStaff: { ...staffMember, name: user.name, role: user.role } });
  },

  ...createRemoteActions(set, get),
}));

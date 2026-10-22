import type {
  AdmissionBilling, ArrivalMode, Bill, Drug, Encounter, ErDisposition, Gender, Order, Patient, Prescription, SoapNote, TriageLevel, VitalSet,
} from '../types/index.ts';
import { api } from './client.ts';

/**
 * Calls for the clinical screens: patients, visits (OPD / emergency / inpatient), pharmacy, billing, dashboard.
 * The backend's shapes are close to the screens' own types; the mappers below close the gaps (null -> undefined,
 * temperature naming, nested visit details).
 */
const clean = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null ? undefined : clean(v)])) as T;
  }
  return value;
};

// ---- Patients ---------------------------------------------------------------------------------
interface PatientDto extends Omit<Patient, 'age' | 'phone'> {
  age: number | null;
  phone: string | null;
  /** 91-1234-5678-9012 (the plain `abhaNumber` is the 14 digits) */
  abhaNumberFormatted?: string | null;
}

const toPatient = (dto: PatientDto): Patient => {
  const { abhaNumberFormatted, ...rest } = dto;
  return clean({ ...rest, abhaNumber: abhaNumberFormatted ?? rest.abhaNumber, age: dto.age ?? 0, phone: dto.phone ?? '' }) as Patient;
};

export const fetchPatients = async (): Promise<Patient[]> => (await api<PatientDto[]>('/patients?limit=200')).map(toPatient);
/** One patient, however long ago they registered (the lists above hold the most recent ones). */
export const fetchPatient = async (id: string): Promise<Patient> => toPatient(await api<PatientDto>(`/patients/${id}`));
/** Patients matching a name, MRN, mobile number or ABHA (searched on the server, so it works however many patients there are). */
export const searchPatientsApi = async (text: string): Promise<Patient[]> => (await api<PatientDto[]>(`/patients?search=${encodeURIComponent(text)}&limit=12`)).map(toPatient);

export interface NewPatient { name: string; age: number; gender: Gender; phone: string; allergies: string[]; problemList: string[] }
export const createPatient = async (input: NewPatient): Promise<Patient> => toPatient(await api<PatientDto>('/patients', { method: 'POST', body: input }));

// ---- Visits -----------------------------------------------------------------------------------
interface VitalDto { takenAt: string; tempF: number | null; pulse: number | null; bp: string | null; spo2: number | null; rr: number | null }
interface EncounterDto extends Omit<Encounter, 'soap' | 'vitals' | 'doctorId'> {
  doctorId: string | null;
  soap: SoapNote | null;
  vitals: VitalDto[];
}

const toVital = (v: VitalDto): VitalSet => ({ takenAt: v.takenAt, temp: v.tempF ?? 0, pulse: v.pulse ?? 0, bp: v.bp ?? '', spo2: v.spo2 ?? 0, rr: v.rr ?? 0 });

export function toEncounter(dto: EncounterDto): Encounter {
  const { vitals, ...rest } = dto;
  return { ...clean(rest), vitals: (vitals ?? []).map(toVital), prescriptions: clean(dto.prescriptions ?? []), orders: clean(dto.orders ?? []) } as Encounter;
}

export const fetchEncounter = async (id: string): Promise<Encounter> => toEncounter(await api<EncounterDto>(`/encounters/${id}`));
export const fetchEncounters = async (): Promise<Encounter[]> => (await api<EncounterDto[]>('/encounters?detail=true&limit=200')).map(toEncounter);
/** All of one patient's visits, with their detail (the patient's chart). */
export const fetchPatientEncounters = async (patientId: string): Promise<Encounter[]> =>
  (await api<EncounterDto[]>(`/encounters?patientId=${encodeURIComponent(patientId)}&detail=true&limit=200`)).map(toEncounter);

const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const checkInOpd = async (patientId: string, department: string, doctorId: string) =>
  toEncounter(await post<EncounterDto>('/encounters/opd', { patientId, department, doctorId }));
export const checkInEr = async (patientId: string, chiefComplaint: string, triageLevel: TriageLevel, arrivalMode: ArrivalMode, doctorId: string) =>
  toEncounter(await post<EncounterDto>('/encounters/er', { patientId, chiefComplaint, triageLevel, arrivalMode, doctorId }));
export const startConsultApi = (id: string) => post(`/encounters/${id}/start`);
export const saveSoapApi = (id: string, soap: SoapNote) => api(`/encounters/${id}/soap`, { method: 'PUT', body: soap });
export const addVitalsApi = (id: string, v: Omit<VitalSet, 'takenAt'>) =>
  post(`/encounters/${id}/vitals`, { tempF: v.temp || undefined, pulse: v.pulse || undefined, bp: v.bp || undefined, spo2: v.spo2 || undefined, rr: v.rr || undefined });
export const addPrescriptionApi = (id: string, rx: Omit<Prescription, 'id' | 'dispensed'>) => post(`/encounters/${id}/prescriptions`, rx);
export const addOrderApi = (id: string, order: Omit<Order, 'id' | 'status'>) => post(`/encounters/${id}/orders`, order);
export const closeOpdApi = (id: string) => post(`/encounters/${id}/close`);
export const setTriageApi = (id: string, triageLevel: TriageLevel) => api(`/encounters/${id}/triage`, { method: 'PATCH', body: { triageLevel } });
export const resolveErApi = (id: string, disposition: ErDisposition, note: string, referredTo?: string) =>
  post(`/encounters/${id}/er-disposition`, { disposition, note, referredTo });
/** Admit straight to a bed (no earlier OPD/ER visit). */
export const admitDirectApi = async (patientId: string, department: string, doctorId: string, bedId: string, billing?: AdmissionBilling) =>
  toEncounter(await post<EncounterDto>('/encounters/ipd', { patientId, department, doctorId, bedId, ...billing }));
/** Admit from an OPD or ER visit: the visit is closed as "admitted" and billed, and a new inpatient stay starts. */
export const admitFromApi = async (sourceId: string, department: string, doctorId: string, bedId: string, billing?: AdmissionBilling) =>
  toEncounter((await post<{ admission: EncounterDto }>(`/encounters/${sourceId}/admit`, { department, doctorId, bedId, ...billing })).admission);
export const transferBedApi = (id: string, bedId: string) => post(`/encounters/${id}/transfer-bed`, { bedId });
/** A draft for the clinician to review: written by an AI model when the server has one configured, otherwise from a template. */
export const draftDischargeApi = (id: string) => post<{ draft: string; source: 'ai' | 'template' }>(`/encounters/${id}/discharge-draft`);
export const dischargeApi = (id: string, summary: string) => post(`/encounters/${id}/discharge`, { summary });

// ---- Pharmacy ---------------------------------------------------------------------------------
export const fetchDrugs = async (): Promise<Drug[]> => clean(await api<Drug[]>('/pharmacy/drugs'));

export interface PharmacyQueueItem {
  rx: Prescription;
  encounterId: string;
  encounterType: Encounter['type'];
  patientId: string;
  patientName: string;
}
interface QueueDto { id: string; drugName: string; dose: string; frequency: string; duration: string; encounterId: string; encounterType: Encounter['type']; patientId: string; patientName: string }
export const fetchPharmacyQueue = async (): Promise<PharmacyQueueItem[]> =>
  (await api<QueueDto[]>('/pharmacy/queue')).map((q) => ({
    rx: { id: q.id, drugName: q.drugName, dose: q.dose, frequency: q.frequency, duration: q.duration, dispensed: false },
    encounterId: q.encounterId, encounterType: q.encounterType, patientId: q.patientId, patientName: q.patientName,
  }));
export const dispenseApi = (prescriptionId: string) => post(`/pharmacy/prescriptions/${prescriptionId}/dispense`);

// ---- Billing ----------------------------------------------------------------------------------
export const fetchBills = async (): Promise<Bill[]> => clean(await api<Bill[]>('/bills?limit=200'));
export const finalizeBillApi = (id: string) => post(`/bills/${id}/finalize`);
export const payBillApi = (id: string) => post(`/bills/${id}/pay`);

// ---- Dashboard --------------------------------------------------------------------------------
export interface DashboardSummary {
  opdWaiting: number; opdAwaitingPayment: number; erActive: number; erRedTriage: number; bedsTotal: number; bedsOccupied: number; occupancyPct: number;
  patients: number; abhaLinkedPct: number; draftBills: number; lowStockDrugs: number; lowStockSupplies: number; wasteAwaitingDisposal: number;
  labPending: number; criticalResults: number;
}
export const fetchDashboard = () => api<DashboardSummary>('/dashboard');

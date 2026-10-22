import type {
  AttendanceEntry, AttendanceStatus, Bed, HousekeepingLogEntry, PayrollRun, RosterEntry, Shift, Staff, Supply, SupplyCategory,
  SupplyLogEntry, WasteBatch, WasteCategory,
} from '../types/index.ts';
import { api } from './client.ts';

/**
 * Calls for the hospital-operations screens: staff, attendance, payroll, roster, supplies, waste, housekeeping.
 * The backend returns null for "not set"; the screens use undefined, so every response goes through `clean`.
 */
function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null ? undefined : clean(v)])) as T;
  }
  return value;
}
const get = async <T>(path: string) => clean(await api<T>(path));

// ---- Staff ------------------------------------------------------------------------------------
export const fetchStaff = () => get<Staff[]>('/staff');

export interface StaffInput {
  name: string;
  role: Staff['role'];
  department: string;
  employmentType: Staff['employmentType'];
  monthlySalary?: number;
  feePerConsult?: number;
  bankAccountLast4?: string;
}
export const createStaff = (input: StaffInput) => api<Staff>('/staff', { method: 'POST', body: input });
export interface StaffUpdate {
  employmentType?: Staff['employmentType'];
  /** null clears the value */
  monthlySalary?: number | null;
  feePerConsult?: number | null;
  /** What a patient pays to see this doctor; null clears it (the standard OPD fee applies). */
  consultationFee?: number | null;
  bankAccountLast4?: string | null;
}
export const updateStaff = (id: string, input: StaffUpdate) => api<Staff>(`/staff/${id}`, { method: 'PATCH', body: input });

// ---- Attendance and payroll (administrators) --------------------------------------------------
export const fetchAttendance = (month: string) => get<AttendanceEntry[]>(`/payroll/attendance?month=${month}`);
export const saveAttendance = (staffId: string, date: string, shift: Shift, status: AttendanceStatus) =>
  api<AttendanceEntry>('/payroll/attendance', { method: 'PUT', body: { staffId, date, shift, status } });

interface RunSummary { id: string }
export async function fetchPayrollRuns(): Promise<PayrollRun[]> {
  const summaries = await api<RunSummary[]>('/payroll/runs');
  return Promise.all(summaries.map((s) => fetchPayrollRun(s.id)));
}
export const fetchPayrollRun = (id: string) => get<PayrollRun>(`/payroll/runs/${id}`);
export const generatePayroll = (month: string) => api<PayrollRun>('/payroll/runs', { method: 'POST', body: { month } });
export const saveDeduction = (runId: string, staffId: string, deductions: number) =>
  api<PayrollRun>(`/payroll/runs/${runId}/lines/${staffId}`, { method: 'PATCH', body: { deductions } });
export const finalizePayroll = (runId: string) => api<PayrollRun>(`/payroll/runs/${runId}/finalize`, { method: 'POST', body: {} });
export const payPayroll = (runId: string) => api<PayrollRun>(`/payroll/runs/${runId}/pay`, { method: 'POST', body: {} });

// ---- Roster -----------------------------------------------------------------------------------
export const fetchRoster = (from: string, to: string) => get<RosterEntry[]>(`/roster?from=${from}&to=${to}`);
export const toggleRoster = (staffId: string, date: string, shift: Shift, department: string) =>
  api<{ assigned: boolean }>('/roster/toggle', { method: 'POST', body: { staffId, date, shift, department } });
export const copyRosterWeek = (fromStart: string, toStart: string) =>
  api<{ copied: number }>('/roster/copy-week', { method: 'POST', body: { fromStart, toStart } });

// ---- Supplies ---------------------------------------------------------------------------------
export const fetchSupplies = () => get<Supply[]>('/supplies');
export const fetchSupplyLog = () => get<SupplyLogEntry[]>('/supplies/log?limit=200').then((rows) => rows.map((r) => ({ ...r, id: String(r.id) })));
export const createSupply = (input: { name: string; category: SupplyCategory; unit: string; stock: number; reorderLevel: number; location: string }) =>
  api<Supply>('/supplies', { method: 'POST', body: input });
export const issueSupplyApi = (id: string, qty: number, department: string) =>
  api<Supply>(`/supplies/${id}/issue`, { method: 'POST', body: { qty, department } });
export const restockSupplyApi = (id: string, qty: number) => api<Supply>(`/supplies/${id}/restock`, { method: 'POST', body: { qty } });

// ---- Bio-medical waste ------------------------------------------------------------------------
export const fetchWaste = () => get<WasteBatch[]>('/waste');
export const segregateWaste = (category: WasteCategory, department: string, weightKg: number) =>
  api<WasteBatch>('/waste', { method: 'POST', body: { category, department, weightKg } });
export const storeWaste = (id: string, location: string) => api<WasteBatch>(`/waste/${id}/store`, { method: 'POST', body: { location } });
export const pretreatWaste = (id: string, method: string) => api<WasteBatch>(`/waste/${id}/pretreat`, { method: 'POST', body: { method } });
export const disposeWaste = (id: string, vendor: string, manifestNo: string) =>
  api<WasteBatch>(`/waste/${id}/dispose`, { method: 'POST', body: { vendor, manifestNo } });

// ---- Beds and housekeeping --------------------------------------------------------------------
export const fetchBeds = () => get<Bed[]>('/beds');
export const fetchHousekeepingLog = () =>
  get<HousekeepingLogEntry[]>('/beds/housekeeping-log?limit=200').then((rows) => rows.map((r) => ({ ...r, id: String(r.id) })));
export const startCleaningApi = (bedId: string) => api<Bed>(`/beds/${bedId}/start-cleaning`, { method: 'POST', body: {} });
export const completeCleaningApi = (bedId: string) => api<Bed>(`/beds/${bedId}/complete-cleaning`, { method: 'POST', body: {} });

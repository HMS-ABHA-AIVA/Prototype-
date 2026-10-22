import { api, setPlatformToken } from './client.ts'

/** A hospital as the platform console lists it. */
export interface Hospital {
  id: string
  /** the hospital's HFR ID (also its ABDM HIP id) */
  code: string
  hfrId: string
  name: string
  ownerEmail: string
  status: 'active' | 'suspended'
  createdAt: string
  suspendedAt: string | null
  /** active logins */
  logins: number
  patients: number
}

export interface HospitalInput {
  hfrId: string
  name: string
  adminName: string
  adminEmail: string
  adminPassword: string
  /** the facility owner's login (ABDM credentials, facility setup); the administrator's e-mail when left out */
  ownerEmail?: string
}

export interface PlatformAuditRow {
  id: number
  at: string
  actor: string
  action: string
  detail: string
}

export async function platformSignIn(username: string, password: string): Promise<void> {
  const { token } = await api<{ token: string }>('/platform/login', { method: 'POST', body: { username, password }, platform: true })
  setPlatformToken(token)
}

export const platformMe = () => api<{ admin: { name: string; username: string } }>('/platform/me', { platform: true })
export const listHospitals = () => api<Hospital[]>('/platform/facilities', { platform: true })
export const createHospital = (input: HospitalInput) => api<Hospital>('/platform/facilities', { method: 'POST', body: input, platform: true })
export const updateHospital = (id: string, change: { name?: string; status?: 'active' | 'suspended' }) =>
  api<Hospital>(`/platform/facilities/${id}`, { method: 'PATCH', body: change, platform: true })
export const setHospitalAdminLogin = (id: string, email: string, password: string) =>
  api<{ ok: true }>(`/platform/facilities/${id}/admin-login`, { method: 'POST', body: { email, password }, platform: true })
export const platformAudit = () => api<PlatformAuditRow[]>('/platform/audit', { platform: true })

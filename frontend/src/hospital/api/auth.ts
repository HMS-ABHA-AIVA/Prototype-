import type { Role } from '../types/index.ts'
import { api } from './client.ts'

/**
 * The signed-in staff member, as the hospital screens see them. Signing in and out, and choosing a new password, go through
 * the application's one sign-in (@/store/useAuthStore); the server's GET /api/v1/auth/me is its source.
 */
export interface SessionUser {
  /** the staff record's id */
  id: string
  /** the login's id */
  userId: string
  name: string
  role: Role
  department: string
  email: string
  /** the same as `email` (OSHealth's screens called it the username) */
  username: string
  mustChangePassword: boolean
  facilityName: string
  /** the hospital's HFR ID */
  facilityCode: string
}

/** A staff member as an administrator sees them on the Staff access screen. */
export interface AccessRow {
  id: string
  name: string
  role: Role
  department: string
  active: boolean
  /** the e-mail address they sign in with */
  email: string | null
  username: string | null
  hasLogin: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  /** When this person asked for a password reset that is still waiting. */
  resetRequestedAt?: string | null
}

export const listAccess = () => api<AccessRow[]>('/staff')

export const setLogin = (staffId: string, email: string, password: string) =>
  api<AccessRow>(`/staff/${staffId}/login`, { method: 'PUT', body: { email, password } })

export const removeLogin = (staffId: string) => api<AccessRow>(`/staff/${staffId}/login`, { method: 'DELETE' })

export const setActive = (staffId: string, active: boolean) => api<AccessRow>(`/staff/${staffId}`, { method: 'PATCH', body: { active } })

/** "I forgot my password": asks an administrator to reset it. The answer is the same whether or not the address has a login. */
export const forgotPassword = (email: string) => api<{ message: string }>('/auth/forgot-password', { method: 'POST', body: { email } })

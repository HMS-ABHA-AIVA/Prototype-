/**
 * Talks to the hospital modules of the merged backend (`/api/v1`). The session is the same httpOnly cookie the rest of the
 * application uses (set by the one sign-in, POST /api/user/admin/login), so nothing here stores a token. The platform console
 * is the exception: it signs in separately and sends its own token, which never opens a hospital.
 */
import { API_BASE, notifySessionExpired } from '@/api/client'

/** The hospital modules always run against the backend (the stand-alone demo mode of OSHealth is not part of the merged app). */
export const apiEnabled = true

const V1 = `${API_BASE}/v1`

/** A failed API call, carrying a message that is safe to show to staff. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// ---- The platform console's own token ---------------------------------------------------------
// Kept in sessionStorage: it disappears when the browser tab is closed, so a shared computer is not left signed in.
const PLATFORM_TOKEN_KEY = 'aiva-oshealth-platform-token'

export function getPlatformToken(): string | null {
  try {
    return sessionStorage.getItem(PLATFORM_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setPlatformToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(PLATFORM_TOKEN_KEY, token)
    else sessionStorage.removeItem(PLATFORM_TOKEN_KEY)
  } catch {
    // storage blocked: sign in again after a reload
  }
}

// ---- What a refusal means for the session -------------------------------------------------------
let onPasswordChangeRequired: () => void = () => {}
/** Registered by the auth store: the server wants a new password chosen before anything else. */
export const setPasswordChangeRequiredHandler = (handler: () => void) => {
  onPasswordChangeRequired = handler
}

type ErrorBody = { error?: { code?: string; message?: string; details?: { field: string; message: string }[] } } | null

/** Turns a refused response into an ApiError, and ends the session when the server says it has ended. */
function failure(response: Response, data: ErrorBody, platform: boolean, fallback?: string): ApiError {
  const error = data?.error
  const detail = error?.details?.length ? ` (${error.details.map((d) => `${d.field}: ${d.message}`).join('; ')})` : ''
  const code = error?.code ?? 'ERROR'
  if (!platform) {
    // Expired, deactivated, password changed elsewhere, or the hospital switched off: back to the sign-in screen.
    if (response.status === 401 || code === 'HOSPITAL_SUSPENDED') notifySessionExpired()
    if (code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired()
  }
  return new ApiError(`${error?.message ?? fallback ?? `Request failed (${response.status})`}${detail}`, response.status, code)
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch {
    throw new ApiError('Cannot reach the server. Please check the connection and try again.', 0, 'NETWORK')
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Use the platform console's token instead of the staff session. */
  platform?: boolean
}

export async function api<T>(path: string, { method = 'GET', body, platform = false }: RequestOptions = {}): Promise<T> {
  const token = platform ? getPlatformToken() : null
  const response = await send(`${V1}${path}`, {
    method,
    // The staff session is a cookie; the platform console never sends it.
    credentials: platform ? 'omit' : 'include',
    headers: {
      // State-changing requests must be JSON, even without a payload (the backend's CSRF guard).
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw failure(response, data, platform)
  return data as T
}

/** Sends a file as the request body (an attached document, a radiology image); its details go in the address. */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const response = await send(`${V1}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw failure(response, data, false, `The upload failed (${response.status})`)
  return data as T
}

/** Opens a stored file in a new tab. It needs the session, so it is fetched and shown from memory. */
export async function openFile(path: string, notOpened: string): Promise<void> {
  const response = await send(`${V1}${path}`, { credentials: 'include' })
  if (!response.ok) throw failure(response, await response.json().catch(() => null), false, notOpened)
  const url = URL.createObjectURL(await response.blob())
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Same-origin by default: the Vite dev/preview server proxies `/api` to the backend (see vite.config.ts), so the
// httpOnly auth cookies stay first-party. Set VITE_API_URL only when the frontend is served from a different origin
// than the API (that origin must then be listed in the backend's FRONTEND_URL).
const BASE: string = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

/** Where the API lives ("/api" or VITE_API_URL); the hospital modules are under `${API_BASE}/v1`. */
export const API_BASE = BASE;

export class ApiError extends Error {
  status: number;
  /** Stable reason from the backend (e.g. "ABHA_NOT_FOUND"), when it gave one. */
  code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onSessionExpired: (() => void) | null = null;

/** Registered by the auth store so a lapsed login cookie sends the user back to /login. */
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

/** The login has lapsed or was ended elsewhere (password changed, access removed): back to sign-in. */
export function notifySessionExpired() {
  onSessionExpired?.();
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, { ...init, credentials: 'include' });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that the backend is running.');
  }
}

/** Turns a non-2xx response into an ApiError, signing the user out when their login has lapsed. */
function failure(res: Response, payload: { message?: unknown; code?: unknown } | null): ApiError {
  const message =
    typeof payload?.message === 'string'
      ? payload.message
      : res.status >= 500
        ? 'The server is unavailable. Check that the backend is running.'
        : `Request failed (${res.status})`;
  // Backend auth middleware answers "unauthorized access"; ABDM-token problems say
  // "ABDM authentication required" and must not log the user out.
  if (res.status === 401 && /unauthor/i.test(message)) onSessionExpired?.();
  return new ApiError(res.status, message, typeof payload?.code === 'string' ? payload.code : undefined);
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await send(path, {
    method,
    // The API only accepts JSON on state-changing requests (CSRF guard), even when there is no payload.
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) throw failure(res, payload);
  return payload as T;
}

export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body);
export const del = <T>(path: string) => request<T>('DELETE', path);
export const get = <T>(path: string) => request<T>('GET', path);

export async function getBlob(path: string): Promise<Blob> {
  const res = await send(path, { method: 'GET' });
  if (!res.ok) throw failure(res, await res.json().catch(() => null));
  return await res.blob();
}

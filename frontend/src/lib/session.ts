import type { StaffRole } from '@/api/endpoints';

// The backend authenticates with httpOnly cookies the browser can't read, so we remember who logged in ourselves.
// This is only UI state; the cookies remain the real credential (and GET /api/v1/auth/me refreshes it from the server).
export type Session =
  | {
      kind: 'staff';
      /** the login's id */
      id: string;
      name: string;
      email: string;
      facilityName?: string | null;
      role: StaffRole;
      /** the staff record's id (the hospital modules know people by it) */
      staffId: string;
      department: string;
      mustChangePassword: boolean;
      /** the hospital's HFR ID */
      facilityCode?: string | null;
    }
  | { kind: 'facility'; name: string; email: string; hfrId: string };

const KEY = 'aiva.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    const session = raw ? (JSON.parse(raw) as Session) : null;
    // A staff session saved before roles existed: sign in again so the menu matches what the person may do.
    if (session?.kind === 'staff' && (!session.role || !session.staffId)) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // storage unavailable (private mode): the session just won't survive a reload
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

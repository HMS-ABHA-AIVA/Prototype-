import { create } from 'zustand';
import { resetAbdmSession } from '@/api/abdmSession';
import { setSessionExpiredHandler } from '@/api/client';
import { loginFacility, loginStaff, logoutFacility, logoutStaff, type AbdmEnvironment, type StaffRole } from '@/api/endpoints';
import { api, setPasswordChangeRequiredHandler } from '@/hospital/api/client';
import { clearSession, loadSession, saveSession, type Session } from '@/lib/session';

const ENVIRONMENT: AbdmEnvironment = import.meta.env.VITE_ABDM_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';

/** The signed-in staff member as the server describes them (GET /api/v1/auth/me). */
interface Me {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: StaffRole;
  department: string;
  mustChangePassword: boolean;
  facilityName: string;
  facilityCode: string | null;
}

const staffSession = (me: Me): Session => ({
  kind: 'staff',
  id: me.userId,
  name: me.name,
  email: me.email,
  facilityName: me.facilityName,
  role: me.role,
  staffId: me.id,
  department: me.department,
  mustChangePassword: me.mustChangePassword,
  facilityCode: me.facilityCode,
});

interface AuthState {
  session: Session | null;
  /** Which ABDM environment ABHA calls run against (VITE_ABDM_ENVIRONMENT). */
  environment: AbdmEnvironment;
  signInStaff: (email: string, password: string) => Promise<void>;
  signInFacility: (email: string, password: string) => Promise<void>;
  /** Refreshes the staff member's details from the server (role, hospital, whether a new password is due). */
  refreshStaff: () => Promise<void>;
  /** Changes the signed-in staff member's password; the server hands out a new session cookie with it. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
}

// Both logins set the same `accessToken` cookie, so only one can be active at a time.
export const useAuthStore = create<AuthState>((set, get) => ({
  session: loadSession(),
  environment: ENVIRONMENT,

  signInStaff: async (email, password) => {
    await loginStaff({ email, password });
    // The login's answer is enough for the M1 screens; /auth/me also gives the staff record and the hospital's code.
    const { user } = await api<{ user: Me }>('/auth/me');
    const session = staffSession(user);
    saveSession(session);
    resetAbdmSession();
    set({ session });
  },

  signInFacility: async (email, password) => {
    const { data } = await loginFacility({ email, password });
    const session: Session = { kind: 'facility', name: data.name, email: data.email, hfrId: data.hfrId };
    saveSession(session);
    resetAbdmSession();
    set({ session });
  },

  refreshStaff: async () => {
    if (get().session?.kind !== 'staff') return;
    const { user } = await api<{ user: Me }>('/auth/me'); // a lapsed session ends through the API client
    const session = staffSession(user);
    saveSession(session);
    set({ session });
  },

  changePassword: async (currentPassword, newPassword) => {
    const { user } = await api<{ ok: true; user: Me }>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    const session = staffSession(user);
    saveSession(session);
    set({ session });
  },

  signOut: async () => {
    const { session } = get();
    try {
      if (session?.kind === 'staff') await logoutStaff(get().environment);
      if (session?.kind === 'facility') await logoutFacility();
    } catch {
      // the cookie may already have expired; we are logging out locally regardless
    }
    clearSession();
    resetAbdmSession();
    // Full reload so no in-memory patient data outlives the login.
    window.location.assign('/login');
  },
}));

// A lapsed login cookie: forget the session and reload so the previous user's data leaves memory.
setSessionExpiredHandler(() => {
  clearSession();
  resetAbdmSession();
  if (window.location.pathname !== '/login') window.location.assign('/login?ended=1');
});

// The server wants a new password chosen first (a new or reset login): the app shows the change-password screen.
setPasswordChangeRequiredHandler(() => {
  const { session } = useAuthStore.getState();
  if (session?.kind === 'staff' && !session.mustChangePassword) {
    const next: Session = { ...session, mustChangePassword: true };
    saveSession(next);
    useAuthStore.setState({ session: next });
  }
});

import { useMemo } from 'react';
import { useAuthStore as useAppAuthStore } from '@/store/useAuthStore';
import type { SessionUser } from '../api/auth.ts';

/**
 * The hospital screens' view of who is signed in. The application has one sign-in (see @/store/useAuthStore); this hook
 * presents it the way the OSHealth screens expect it.
 */
export interface HospitalAuth {
  /** The signed-in staff member; null for a facility-owner session. */
  user: SessionUser | null;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export function useAuthStore(): HospitalAuth;
export function useAuthStore<T>(select: (state: HospitalAuth) => T): T;
export function useAuthStore<T>(select?: (state: HospitalAuth) => T): T | HospitalAuth {
  const session = useAppAuthStore((s) => s.session);
  const signOut = useAppAuthStore((s) => s.signOut);
  const changePassword = useAppAuthStore((s) => s.changePassword);
  const state = useMemo<HospitalAuth>(
    () => ({
      user:
        session?.kind === 'staff'
          ? {
              id: session.staffId,
              userId: session.id,
              name: session.name,
              role: session.role,
              department: session.department,
              email: session.email,
              username: session.email,
              mustChangePassword: session.mustChangePassword,
              facilityName: session.facilityName ?? '',
              facilityCode: session.facilityCode ?? '',
            }
          : null,
      logout: () => void signOut(),
      changePassword,
    }),
    [session, signOut, changePassword],
  );
  return select ? select(state) : state;
}

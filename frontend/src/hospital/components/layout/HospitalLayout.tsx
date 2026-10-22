import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { useAuthStore } from '@/store/useAuthStore';
import { useHospitalStore } from '../../store/useHospitalStore';
import { navKeyFor } from './navConfig';

/**
 * The hospital modules' pages (OPD, IPD, pharmacy, lab, billing ...) inside the application's shell. Their own styles apply
 * only inside `.os-page` (see hospital/styles/modules.css), so they never change the M1 screens. Who may open which page is
 * checked by RequireSession before this renders.
 */
export function HospitalLayout() {
  const session = useAuthStore((s) => s.session);
  const signInAs = useHospitalStore((s) => s.signInAs);
  const { pathname } = useLocation();
  const staff = session?.kind === 'staff' ? session : null;

  // The person who signed in drives the screens' menus and actions (their role, and their name on what they record).
  useEffect(() => {
    if (staff) signInAs({ id: staff.staffId, name: staff.name, role: staff.role, department: staff.department });
  }, [staff?.staffId, staff?.role, staff?.name, staff?.department, signInAs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!staff) return null;
  return (
    <AppShell active={navKeyFor(staff.role, pathname) ?? ''}>
      <div className="os-page">
        <Suspense fallback={<div className="empty-state">Loading…</div>}>
          <Outlet />
        </Suspense>
      </div>
    </AppShell>
  );
}

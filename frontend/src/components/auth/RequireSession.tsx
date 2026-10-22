import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { AppShell } from '@/components/AppShell';
import { EmptyState } from '@/components/ui/kit';
import { canOpenPath, ROLE_LABELS } from '@/hospital/components/layout/navConfig';
import { ChangePasswordDialog } from '@/hospital/modules/auth/ChangePasswordDialog';

// Once per page load: confirm the saved staff session with the server (role, hospital, whether a new password is due).
let confirmed = false;

/** Staff sessions use the HMIS screens; facility sessions only get facility setup. */
export function RequireSession({ kind }: { kind: 'staff' | 'facility' }) {
  const session = useAuthStore((s) => s.session);
  const refreshStaff = useAuthStore((s) => s.refreshStaff);
  const location = useLocation();

  useEffect(() => {
    if (session?.kind !== 'staff' || confirmed) return;
    confirmed = true;
    refreshStaff().catch(() => undefined); // a lapsed session ends through the API client
  }, [session?.kind, refreshStaff]);

  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.kind !== kind) return <Navigate to={session.kind === 'facility' ? '/facility-setup' : '/'} replace />;

  if (session.kind === 'staff') {
    // A new or reset login chooses its own password before anything else (the server refuses everything else until then).
    if (session.mustChangePassword) return <ChangePasswordDialog forced />;
    if (!canOpenPath(session.role, location.pathname)) {
      return (
        <AppShell active="">
          <EmptyState
            icon={ShieldOff}
            title="Not available for your role"
            text={`This screen is not part of the ${ROLE_LABELS[session.role].toLowerCase()} role's work. Use the menu to open your screens, or ask an administrator.`}
          />
        </AppShell>
      );
    }
  }
  return <Outlet />;
}

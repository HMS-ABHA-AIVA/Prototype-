import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiEnabled } from '../../api/client';
import { listAccess, removeLogin, setActive, setLogin, type AccessRow } from '../../api/auth';
import { useAuthStore } from '../../store/useAuthStore';

const ROLE_LABELS: Record<string, string> = {
  front_office: 'Front Office', doctor: 'Doctor', nurse: 'Nurse', pharmacist: 'Pharmacist', biller: 'Biller', housekeeping: 'Housekeeping', lab: 'Lab & Radiology', admin: 'Administrator',
};

/** Administrator screen: who can sign in, set or reset a login, remove access. */
export function StaffAccessPage() {
  const me = useAuthStore((s) => s.user);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccessRow | null>(null);
  const waiting = (rows ?? []).filter((r) => r.resetRequestedAt).length;

  const load = useCallback(async () => {
    try {
      setRows(await listAccess());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load staff');
    }
  }, []);
  useEffect(() => { if (apiEnabled) void load(); }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    }
  };

  if (!apiEnabled) {
    return (
      <>
        <div className="os-head"><div><h1>Staff Access</h1></div></div>
        <div className="card">Sign-in is available when the app is connected to the backend (VITE_API_URL). This demo runs without it.</div>
      </>
    );
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Staff Access</h1>
          <div className="sub">Who can sign in. A new or reset password must be changed by the person at their next sign-in.</div>
        </div>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {waiting > 0 && (
        <div className="login-notice">
          {waiting} {waiting === 1 ? 'person has' : 'people have'} asked for a password reset. Use "Reset password" on their row to set a new temporary password.
        </div>
      )}

      <div className="card table-scroll">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Sign-in e-mail</th><th>Status</th><th>Last sign-in</th><th /></tr>
          </thead>
          <tbody>
            {[...(rows ?? [])].sort((a, b) => Number(!!b.resetRequestedAt) - Number(!!a.resetRequestedAt)).map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{r.name}<div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{r.department}</div></td>
                <td>{ROLE_LABELS[r.role] ?? r.role}</td>
                <td className="mono">{r.email ?? '—'}</td>
                <td>
                  {r.resetRequestedAt && r.active && <div style={{ marginBottom: 4 }}><span className="badge danger">Reset requested</span></div>}
                  {!r.active ? <span className="badge neutral">Deactivated</span>
                    : !r.hasLogin ? <span className="badge warn">No login</span>
                    : r.mustChangePassword ? <span className="badge info">Must set password</span>
                    : <span className="badge ok">Can sign in</span>}
                </td>
                <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString('en-IN') : 'Never'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => setEditing(r)}>{r.hasLogin ? 'Reset password' : 'Create login'}</button>{' '}
                  {r.hasLogin && r.id !== me?.id && (
                    <button className="btn btn-sm btn-danger" onClick={() => window.confirm(`Remove the login of ${r.name}?`) && act(() => removeLogin(r.id))}>Remove login</button>
                  )}{' '}
                  {r.id !== me?.id && (
                    <button className="btn btn-sm btn-ghost" onClick={() => act(() => setActive(r.id, !r.active))}>{r.active ? 'Deactivate' : 'Reactivate'}</button>
                  )}
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={6} className="empty-state">No staff yet.</td></tr>}
            {!rows && !error && <tr><td colSpan={6} className="empty-state">Loading…</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && <LoginDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </>
  );
}

function LoginDialog({ row, onClose, onSaved }: { row: AccessRow; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState(row.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setLogin(row.id, email.trim().toLowerCase(), password);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head"><h3>{row.hasLogin ? 'Reset password' : 'Create login'} — {row.name}</h3></div>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="acc-email">E-mail address (they sign in with it)</label>
          <input id="acc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="name@hospital.in" required />
        </div>
        <div className="field">
          <label htmlFor="acc-password">Temporary password</label>
          <input id="acc-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder="At least 10 characters, a letter and a digit" required />
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 5 }}>Tell the person this password in private. They will choose their own when they first sign in.</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !email || !password}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

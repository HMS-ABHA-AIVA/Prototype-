import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getPlatformToken, setPlatformToken } from '../../api/client';
import {
  createHospital, listHospitals, platformAudit, platformMe, platformSignIn, setHospitalAdminLogin, updateHospital,
  type Hospital, type PlatformAuditRow,
} from '../../api/platform';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The console for the people who run the product (not a hospital's staff): set up hospitals, switch one off or on, and give a hospital's
 * administrator a new login. It signs in on its own and its token never opens a hospital's patients or records.
 */
export function PlatformPage() {
  const [state, setState] = useState<'checking' | 'signedOut' | 'signedIn'>(getPlatformToken() ? 'checking' : 'signedOut');
  const [who, setWho] = useState('');

  useEffect(() => {
    if (state !== 'checking') return;
    platformMe().then(
      ({ admin }) => { setWho(admin.name); setState('signedIn'); },
      () => { setPlatformToken(null); setState('signedOut'); },
    );
  }, [state]);

  const signOut = () => { setPlatformToken(null); setState('signedOut'); };

  if (state === 'checking') return <div className="login-wrap"><div className="login-notice">Loading…</div></div>;
  if (state === 'signedOut') return <PlatformLogin onDone={(name) => { setWho(name); setState('signedIn'); }} />;
  return <Console who={who} onSignOut={signOut} onEnded={signOut} />;
}

function PlatformLogin({ onDone }: { onDone: (name: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await platformSignIn(username.trim(), password);
      onDone((await platformMe()).admin.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 20 }}>
          <div className="brand-mark">AO</div>
          <div>
            <div className="brand-name" style={{ color: 'var(--ink)' }}>AIVA OSHealth</div>
            <div className="brand-tag" style={{ color: 'var(--ink-soft)' }}>Platform console</div>
          </div>
        </div>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="platform-username">Username</label>
          <input id="platform-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <div className="field">
          <label htmlFor="platform-password">Password</label>
          <input id="platform-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="card-sub" style={{ marginTop: 12 }}>For the people who set up hospitals. Hospital staff sign in at the main address.</div>
      </form>
    </div>
  );
}

function Console({ who, onSignOut, onEnded }: { who: string; onSignOut: () => void; onEnded: () => void }) {
  const notice = useNoticeStore();
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [audit, setAudit] = useState<PlatformAuditRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Hospital | null>(null);
  const [renaming, setRenaming] = useState<Hospital | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, a] = await Promise.all([listHospitals(), platformAudit()]);
      setHospitals(h);
      setAudit(a);
    } catch (err) {
      if ((err as { status?: number }).status === 401) onEnded();
      else reportError(err);
    }
  }, [onEnded]);

  useEffect(() => { void load(); }, [load]);

  const change = async (h: Hospital, status: 'active' | 'suspended') => {
    const verb = status === 'suspended' ? 'Switch off' : 'Switch on';
    if (!window.confirm(`${verb} access for ${h.name}? ${status === 'suspended' ? 'Their staff will be signed out and cannot sign in until it is switched on again. Nothing is deleted.' : ''}`)) return;
    try {
      await updateHospital(h.id, { status });
      await load();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="main" style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
      <div className="os-head">
        <div>
          <h1>Hospitals</h1>
          <div className="sub">Platform console · signed in as {who}</div>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Set up a hospital</button>
          <button className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead><tr><th>HFR ID</th><th>Hospital</th><th>Status</th><th className="num">Logins</th><th className="num">Patients</th><th>Set up</th><th></th></tr></thead>
          <tbody>
            {hospitals.map((h) => (
              <tr key={h.id}>
                <td className="mono"><b>{h.code}</b></td>
                <td>{h.name}</td>
                <td>{h.status === 'active' ? <Badge tone="ok">Active</Badge> : h.status === 'suspended' ? <Badge tone="danger">Switched off</Badge> : <Badge tone="warn">Setting up</Badge>}</td>
                <td className="num">{h.logins}</td>
                <td className="num">{h.patients}</td>
                <td>{when(h.createdAt)}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" onClick={() => setRenaming(h)}>Rename</button>
                    <button className="btn btn-sm" onClick={() => setResetting(h)}>Administrator login</button>
                    {h.status === 'active' && <button className="btn btn-sm btn-danger" onClick={() => change(h, 'suspended')}>Switch off</button>}
                    {h.status === 'suspended' && <button className="btn btn-sm" onClick={() => change(h, 'active')}>Switch on</button>}
                  </div>
                </td>
              </tr>
            ))}
            {hospitals.length === 0 && <tr><td colSpan={7} className="empty-state">No hospitals yet. Set one up to give it its own records and staff.</td></tr>}
          </tbody>
        </table>
        <div className="card-sub" style={{ marginTop: 10 }}>
          Each hospital's records are kept apart from every other hospital's. Staff sign in at the main address with their e-mail address and password.
        </div>
      </div>

      <div className="card">
        <h3>Recent platform activity</h3>
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
          <tbody>
            {audit.slice(0, 15).map((a) => <tr key={a.id}><td>{when(a.at)}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.detail}</td></tr>)}
            {audit.length === 0 && <tr><td colSpan={4} className="empty-state">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {adding && <NewHospital onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
      {resetting && <AdminLogin hospital={resetting} onClose={() => setResetting(null)} onDone={() => { setResetting(null); void load(); }} />}
      {renaming && <Rename hospital={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); void load(); }} />}
      {notice.message && <div className={`toast ${notice.kind}`} role="alert" onClick={notice.clear}>{notice.message}</div>}
    </div>
  );
}

function NewHospital({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [hfrId, setHfrId] = useState('');
  const [name, setName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = !/^[A-Za-z0-9_-]{1,30}$/.test(hfrId.trim()) || name.trim().length < 3 || adminName.trim().length < 3 || !email.test(adminEmail.trim())
    || (ownerEmail.trim() !== '' && !email.test(ownerEmail.trim())) || adminPassword.length < 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await createHospital({
        hfrId: hfrId.trim(), name: name.trim(), adminName: adminName.trim(), adminEmail: adminEmail.trim().toLowerCase(), adminPassword,
        ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim().toLowerCase() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up the hospital');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Set up a hospital" onClose={onClose} width={560}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="two-col">
          <div className="field"><label>HFR ID *</label><input value={hfrId} onChange={(e) => setHfrId(e.target.value)} maxLength={30} placeholder="e.g. IN2710001234" autoFocus /></div>
          <div className="field"><label>Hospital name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Sunrise Nursing Home" /></div>
        </div>
        <div className="ai-hint" style={{ marginBottom: 10 }}>The facility's Health Facility Registry id. It is also its ABDM HIP id (Scan &amp; Share reaches the hospital by it), so it cannot be changed later.</div>
        <div className="two-col">
          <div className="field"><label>Administrator's name *</label><input value={adminName} onChange={(e) => setAdminName(e.target.value)} maxLength={120} /></div>
          <div className="field"><label>Administrator's e-mail *</label><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} maxLength={254} autoCapitalize="none" /></div>
        </div>
        <div className="field">
          <label>Temporary password * (at least 10 characters, letters and digits)</label>
          <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="field">
          <label>Facility owner's e-mail (optional)</label>
          <input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} maxLength={254} autoCapitalize="none" placeholder="The administrator's e-mail if left empty" />
        </div>
        <div className="ai-hint" style={{ marginBottom: 10 }}>The administrator must choose their own password the first time they sign in. Give them their e-mail address and this temporary password. The facility owner's login (same password) adds the ABDM credentials under Facility setup.</div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Setting up…' : 'Set up hospital'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdminLogin({ hospital, onClose, onDone }: { hospital: Hospital; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setHospitalAdminLogin(hospital.id, email.trim().toLowerCase(), password);
      useNoticeStore.getState().show(`Administrator login saved for ${hospital.name}. They choose a new password at first sign-in.`, 'info');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${hospital.name} · administrator login`} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
          For a hospital whose administrator is locked out or has left. Use an existing administrator's e-mail address to reset their login, or a new address to add one.
        </p>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="field"><label>E-mail address *</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" autoFocus /></div>
        <div className="field"><label>Temporary password * (10+ characters, letters and digits)</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || password.length < 10}>{busy ? 'Saving…' : 'Save login'}</button>
        </div>
      </form>
    </Modal>
  );
}

function Rename({ hospital, onClose, onDone }: { hospital: Hospital; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(hospital.name);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updateHospital(hospital.id, { name: name.trim() });
      onDone();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rename ${hospital.name}`} onClose={onClose} width={440}>
      <form onSubmit={submit}>
        <div className="field"><label>Hospital name</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || name.trim().length < 3}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

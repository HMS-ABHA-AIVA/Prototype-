import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Change your own password. `forced` is the first-sign-in case (an administrator set the password):
 * it fills the screen and cannot be dismissed.
 */
export function ChangePasswordDialog({ forced = false, onClose }: { forced?: boolean; onClose?: () => void }) {
  const { changePassword, logout } = useAuthStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError('The two new passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setDone(true);
      if (!forced) setTimeout(() => onClose?.(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className={forced ? 'login-card' : undefined}>
      <h3 style={{ marginBottom: 4 }}>{forced ? 'Choose your own password' : 'Change password'}</h3>
      <div className="card-sub">
        {forced ? 'An administrator set your first password. Choose a new one to continue.' : 'At least 10 characters, with a letter and a digit.'}
      </div>
      {error && <div className="login-error" role="alert">{error}</div>}
      {done && <div className="login-notice">Password changed.</div>}
      <div className="field">
        <label htmlFor="pw-current">{forced ? 'Password you were given' : 'Current password'}</label>
        <input id="pw-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
      </div>
      <div className="field">
        <label htmlFor="pw-again">New password again</label>
        <input id="pw-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {forced ? (
          <button type="button" className="btn btn-ghost" onClick={logout}>Sign out</button>
        ) : (
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        )}
        <button className="btn btn-primary" disabled={busy || done || !current || !next || !again}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );

  // Shown over the application's own screens too, so it carries the hospital screens' styles with it (.os-page).
  if (forced) return <div className="os-page"><div className="login-wrap">{form}</div></div>;
  return (
    <div className="os-page">
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>{form}</div>
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { fetchFacility, saveFacility, type FacilityProfile } from '../../api/facility';

type Form = Record<keyof FacilityProfile, string>;

const EMPTY: Form = { name: '', hfrId: '', hipId: '', facilityType: '', address: '', state: '', district: '', pincode: '', phone: '', email: '' };

/** Administrator screen: this facility's own details, including the ids ABDM assigns once it is registered. */
export function FacilityProfilePage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchFacility()
      .then((p) => {
        setForm(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, (p as unknown as Record<string, string | null>)[k] ?? ''])) as Form);
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the facility profile'));
  }, []);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Empty boxes are saved as "not set". The ABDM ids are not sent: they are fixed (see below).
      const { hfrId: _hfrId, hipId: _hipId, ...editable } = form;
      const body = Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])) as unknown as FacilityProfile;
      await saveFacility({ ...body, name: form.name.trim() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof Form, label: string, props: { placeholder?: string; hint?: string; readOnly?: boolean } = {}) => (
    <div className="field">
      <label htmlFor={`fac-${key}`}>{label}</label>
      <input id={`fac-${key}`} value={form[key]} onChange={set(key)} placeholder={props.placeholder} readOnly={props.readOnly} disabled={props.readOnly} />
      {props.hint && <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 4 }}>{props.hint}</div>}
    </div>
  );

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Facility Profile</h1>
          <div className="sub">This hospital's details, as they appear on its documents.</div>
        </div>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}
      {saved && <div className="login-notice">Saved.</div>}

      <form className="card" onSubmit={submit} style={{ maxWidth: 720 }}>
        <h3>Hospital</h3>
        <div className="card-sub">Shown on documents and sent to ABDM.</div>
        {field('name', 'Hospital name')}
        <div className="two-col">
          {field('facilityType', 'Type', { placeholder: 'e.g. Nursing Home, Clinic, Hospital' })}
          {field('phone', 'Phone')}
        </div>
        {field('email', 'Email')}
        {field('address', 'Address')}
        <div className="two-col">
          {field('state', 'State')}
          {field('district', 'District')}
        </div>
        {field('pincode', 'PIN code')}

        <h3 style={{ marginTop: 18 }}>ABDM identifiers</h3>
        <div className="card-sub">
          Set when the facility was registered in this application. The HFR ID is also its HIP id: ABDM reaches this hospital by it for Scan &amp; Share,
          so it cannot be changed here. The ABDM credentials are added by the facility owner's login, under Facility setup.
        </div>
        {field('hfrId', 'Health Facility Registry (HFR) ID', { readOnly: true })}
        {field('hipId', 'Health Information Provider (HIP) ID', { readOnly: true })}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-primary" disabled={busy || !loaded || !form.name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </>
  );
}

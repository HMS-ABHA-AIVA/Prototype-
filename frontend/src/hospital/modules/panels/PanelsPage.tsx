import { useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { fetchPanelItemRates, savePanelItemRates, type PanelItemRates } from '../../api/masters';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import type { Panel, PanelCategory, PanelInput } from '../../api/opdBilling';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { rupees } from '../opdbilling/BillingFields';
import { DEPARTMENTS } from '../registration/departments';

const CATEGORY_LABEL: Record<PanelCategory, string> = { government: 'Government scheme', insurance: 'Insurance / TPA', corporate: 'Corporate', other: 'Other' };

/** Common panels to start from. Only the name and kind are filled in: the rates are the hospital's own agreement with each panel. */
const PRESETS: { code: string; name: string; category: PanelCategory }[] = [
  { code: 'CGHS', name: 'Central Government Health Scheme', category: 'government' },
  { code: 'DGHS', name: 'Directorate General of Health Services', category: 'government' },
  { code: 'ECHS', name: 'Ex-Servicemen Contributory Health Scheme', category: 'government' },
  { code: 'ESIC', name: 'Employees State Insurance Corporation', category: 'government' },
  { code: 'PMJAY', name: 'Ayushman Bharat PM-JAY', category: 'government' },
  { code: 'TPA', name: 'Insurance / TPA', category: 'insurance' },
  { code: 'CORP', name: 'Corporate tie-up', category: 'corporate' },
];

/**
 * Panels (CGHS, DGHS, ECHS, insurers, companies) whose beneficiaries are charged special OPD rates. An administrator sets up each panel and
 * enters the rates the hospital has agreed. At OPD billing the staff choose the panel, and each doctor's fee becomes the panel's rate.
 */
export function PanelsPage() {
  const { panels } = useHospitalStore();
  useRefresh(['panels']);
  const [editing, setEditing] = useState<Panel | 'new' | null>(null);
  const [rating, setRating] = useState<Panel | null>(null);
  const [itemRating, setItemRating] = useState<Panel | null>(null);

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Panels &amp; Rates</h1>
          <div className="sub">CGHS, DGHS, ECHS, insurers and companies: the special OPD rates the hospital has agreed with each</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add panel</button>
      </div>

      <div className="card">
        <h3>How a panel's fee is worked out</h3>
        <div className="card-sub" style={{ lineHeight: 1.6 }}>
          For each doctor, OPD billing charges: <b>1.</b> the panel's rate for that doctor's department, if you have entered one; otherwise <b>2.</b> the panel's flat fee
          for every consultation, if set; otherwise <b>3.</b> the doctor's standard fee less the panel's discount %. A panel with none of these set charges the standard fee.
          No rates are built in: enter the ones in your agreement with each panel.
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Panel</th><th>Kind</th><th>Rates</th><th>Card no.</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {panels.map((p) => (
              <tr key={p.id}>
                <td className="mono"><b>{p.code}</b></td>
                <td>{p.name}</td>
                <td>{CATEGORY_LABEL[p.category]}</td>
                <td style={{ fontSize: 12.5 }}>
                  {p.rates.length > 0 && <div>{p.rates.map((r) => `${r.department} ${rupees(r.fee)}`).join(', ')}</div>}
                  {p.flatFee !== null && <div>Flat {rupees(p.flatFee)} for {p.rates.length > 0 ? 'any other department' : 'every department'}</div>}
                  {p.discountPct > 0 && <div>{p.discountPct}% off the standard fee{p.flatFee === null && p.rates.length === 0 ? '' : ' where nothing above applies'}</div>}
                  {!p.hasSpecialRates && <Badge tone="warn">No rates set: standard fees apply</Badge>}
                </td>
                <td>{p.requiresBeneficiaryId ? 'Required' : 'Optional'}</td>
                <td>{p.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm" onClick={() => setRating(p)}>Consultation rates</button>
                    {apiEnabled && <button className="btn btn-sm" onClick={() => setItemRating(p)}>Service &amp; test rates</button>}
                    <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                  </div>
                </td>
              </tr>
            ))}
            {panels.length === 0 && <tr><td colSpan={7} className="empty-state">No panels yet. Add the ones your hospital works with (CGHS, DGHS, ECHS …) and enter their rates.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && <PanelDialog panel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {rating && <RatesDialog panel={rating} onClose={() => setRating(null)} />}
      {itemRating && <ItemRatesDialog panel={itemRating} onClose={() => setItemRating(null)} />}
    </>
  );
}

function PanelDialog({ panel, onClose }: { panel: Panel | null; onClose: () => void }) {
  const { savePanel } = useHospitalStore();
  const [code, setCode] = useState(panel?.code ?? '');
  const [name, setName] = useState(panel?.name ?? '');
  const [category, setCategory] = useState<PanelCategory>(panel?.category ?? 'government');
  const [discountPct, setDiscountPct] = useState(String(panel?.discountPct ?? 0));
  const [flatFee, setFlatFee] = useState(panel?.flatFee != null ? String(panel.flatFee) : '');
  const [requires, setRequires] = useState(panel?.requiresBeneficiaryId ?? true);
  const [active, setActive] = useState(panel?.active ?? true);
  const [busy, setBusy] = useState(false);

  const pct = Number(discountPct);
  const flat = flatFee.trim() === '' ? null : Number(flatFee);
  const invalid = code.trim().length < 2 || !name.trim() || !(pct >= 0 && pct <= 100) || (flat !== null && !(flat >= 0));

  function preset(value: string) {
    const p = PRESETS.find((x) => x.code === value);
    if (p) {
      setCode(p.code);
      setName(p.name);
      setCategory(p.category);
    }
  }

  async function save() {
    if (busy || invalid) return;
    setBusy(true);
    const input: PanelInput & { id?: string } = { id: panel?.id, code, name, category, discountPct: pct, flatFee: flat, requiresBeneficiaryId: requires, active };
    const saved = await savePanel(input);
    setBusy(false);
    if (saved) onClose();
  }

  return (
    <Modal title={panel ? `Edit ${panel.code}` : 'Add a panel'} onClose={onClose} width={560}>
      {!panel && (
        <div className="field">
          <label>Start from</label>
          <select defaultValue="" onChange={(e) => preset(e.target.value)}>
            <option value="">Choose a common panel (or fill in below)…</option>
            {PRESETS.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
          </select>
        </div>
      )}
      <div className="two-col">
        <div className="field"><label>Code *</label><input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="e.g. CGHS" /></div>
        <div className="field">
          <label>Kind</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as PanelCategory)}>
            {(Object.keys(CATEGORY_LABEL) as PanelCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label>Name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
      <div className="two-col">
        <div className="field">
          <label>Flat fee for every consultation (₹)</label>
          <input type="number" min={0} value={flatFee} onChange={(e) => setFlatFee(e.target.value)} placeholder="Leave empty if not used" />
        </div>
        <div className="field">
          <label>Or discount on the standard fee (%)</label>
          <input type="number" min={0} max={100} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
        </div>
      </div>
      <div className="ai-hint" style={{ marginBottom: 10 }}>Department rates (set separately) take priority over both of these.</div>
      <label className="row" style={{ cursor: 'pointer', marginBottom: 6 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={requires} onChange={(e) => setRequires(e.target.checked)} />
        Billing must record the beneficiary / card / referral number
      </label>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active (shown to billing staff)
      </label>
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || invalid} onClick={save}>{busy ? 'Saving…' : 'Save panel'}</button>
      </div>
    </Modal>
  );
}

/** The panel's agreed fee for each department. Replaces the previous list when saved. */
function RatesDialog({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const { savePanelRates, staff } = useHospitalStore();
  const [rows, setRows] = useState<{ department: string; fee: string }[]>(panel.rates.map((r) => ({ department: r.department, fee: String(r.fee) })));
  const [busy, setBusy] = useState(false);
  const departments = [...new Set([...DEPARTMENTS, ...staff.filter((s) => s.role === 'doctor').map((d) => d.department)])];
  const used = rows.map((r) => r.department);
  const free = departments.filter((d) => !used.includes(d));

  const invalid = rows.some((r) => !r.department.trim() || r.fee.trim() === '' || !(Number(r.fee) >= 0));
  const setRow = (i: number, change: Partial<{ department: string; fee: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  async function save() {
    if (busy || invalid) return;
    setBusy(true);
    const ok = await savePanelRates(panel.id, rows.map((r) => ({ department: r.department.trim(), fee: Number(r.fee) })));
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal title={`${panel.code} · department rates`} onClose={onClose} width={560}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
        The fee {panel.code} pays for an OPD consultation in each department. Any department not listed uses the panel's flat fee or discount ({panel.flatFee !== null ? `flat ${rupees(panel.flatFee)}` : panel.discountPct > 0 ? `${panel.discountPct}% off` : 'standard fee'}).
      </p>
      {rows.map((r, i) => (
        <div key={i} className="consult-row">
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <select value={r.department} onChange={(e) => setRow(i, { department: e.target.value })}>
              {[r.department, ...free].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field" style={{ width: 130, marginBottom: 0 }}>
            <input type="number" min={0} value={r.fee} onChange={(e) => setRow(i, { fee: e.target.value })} placeholder="Fee ₹" />
          </div>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${r.department}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" disabled={free.length === 0} onClick={() => setRows([...rows, { department: free[0]!, fee: '' }])} style={{ marginTop: 6 }}>+ Add a department rate</button>
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || invalid} onClick={save}>{busy ? 'Saving…' : 'Save rates'}</button>
      </div>
    </Modal>
  );
}

/**
 * What the panel pays for the hospital's services (bed charges, nursing, procedures, packages) and tests. An item with no rate here is charged at
 * the standard price less the panel's discount %, if it has one. Inpatient stays billed under the panel use these rates.
 */
function ItemRatesDialog({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const [data, setData] = useState<PanelItemRates | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchPanelItemRates(panel.id).then((d) => {
      setData(d);
      const initial: Record<string, string> = {};
      for (const x of d.services) if (x.rate !== null) initial[`service:${x.id}`] = String(x.rate);
      for (const x of d.investigations) if (x.rate !== null) initial[`investigation:${x.id}`] = String(x.rate);
      setRates(initial);
    }, reportError);
  }, [panel.id]);

  const match = (name: string, code: string) => !search || `${name} ${code}`.toLowerCase().includes(search.toLowerCase());
  const bad = Object.values(rates).some((v) => v.trim() !== '' && !(Number(v) >= 0));

  async function save() {
    if (!data || busy || bad) return;
    setBusy(true);
    try {
      const list = Object.entries(rates)
        .filter(([, v]) => v.trim() !== '')
        .map(([key, v]) => ({ kind: key.split(':')[0] as 'service' | 'investigation', itemId: key.split(':')[1]!, rate: Number(v) }));
      await savePanelItemRates(panel.id, list);
      useNoticeStore.getState().show(`${panel.code}: ${list.length} rate(s) saved`, 'info');
      onClose();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  const row = (key: string, name: string, code: string, price: number) => (
    <tr key={key}>
      <td>{name} <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{code}</span></td>
      <td className="num mono">{rupees(price)}</td>
      <td className="num"><input type="number" min={0} style={{ width: 110, textAlign: 'right' }} placeholder="standard" value={rates[key] ?? ''} onChange={(e) => setRates({ ...rates, [key]: e.target.value })} /></td>
    </tr>
  );

  return (
    <Modal title={`${panel.code} · service & test rates`} onClose={onClose} width={760}>
      {!data ? <div className="empty-state">Loading…</div> : (
        <>
          <div className="field"><input placeholder="Search services and tests" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="table">
              <thead><tr><th>Service</th><th className="num">Standard price</th><th className="num">{panel.code} rate (₹)</th></tr></thead>
              <tbody>{data.services.filter((x) => match(x.name, x.code)).map((x) => row(`service:${x.id}`, x.name, x.code, x.price))}</tbody>
              <tbody><tr><th>Test</th><th className="num">Standard price</th><th className="num">{panel.code} rate (₹)</th></tr></tbody>
              <tbody>{data.investigations.filter((x) => match(x.name, x.code)).map((x) => row(`investigation:${x.id}`, x.name, x.code, x.price))}</tbody>
            </table>
            {data.services.length + data.investigations.length === 0 && <div className="empty-state">No services or tests have been set up yet (Masters).</div>}
          </div>
          <div className="ai-hint">Leave a rate empty to charge the standard price{panel.discountPct > 0 ? ` less ${panel.discountPct}%` : ''}.</div>
          <div className="flex-between" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || bad} onClick={save}>{busy ? 'Saving…' : 'Save rates'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

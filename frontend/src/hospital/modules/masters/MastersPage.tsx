import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiEnabled } from '../../api/client';
import {
  SERVICE_CATEGORY_LABEL, createInvestigation, createService, deleteTemplate, fetchInvestigation, fetchInvestigations, fetchServices, fetchSettings, fetchTemplates,
  fetchWards, saveSettings, saveTemplate, saveWardRate, updateInvestigation, updateService,
  type HospitalSettings, type Investigation, type InvestigationInput, type RxTemplate, type Service, type ServiceCategory, type TemplateItem, type Ward,
} from '../../api/masters';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { useHospitalStore } from '../../store/useHospitalStore';
import { rupees } from '../opdbilling/BillingFields';

type Tab = 'wards' | 'services' | 'tests' | 'templates' | 'settings';

/**
 * The lists billing, orders and prescriptions read: what each ward charges a day, the services that can be charged to an admission, the tests the
 * hospital offers (with their normal ranges), saved prescriptions, and the hospital's billing and print settings. Administrators change them;
 * everything else in the product reads from here, so a price is changed in one place.
 */
export function MastersPage() {
  const [tab, setTab] = useState<Tab>('wards');
  if (!apiEnabled) {
    return <div className="card"><h3>Masters</h3><div className="card-sub">The price lists live on the server. Connect the backend (VITE_API_URL) to set them up.</div></div>;
  }
  return (
    <>
      <div className="os-head">
        <div>
          <h1>Masters</h1>
          <div className="sub">The price lists and settings that bills, orders and prescriptions are made from</div>
        </div>
      </div>
      <div className="tabs">
        {([['wards', 'Wards & bed charges'], ['services', 'Services'], ['tests', 'Tests'], ['templates', 'Prescription templates'], ['settings', 'Hospital settings']] as [Tab, string][]).map(([key, label]) => (
          <div key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</div>
        ))}
      </div>
      {tab === 'wards' && <WardsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'tests' && <TestsTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'settings' && <SettingsTab />}
    </>
  );
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

// ---- Wards ---------------------------------------------------------------------------------------------------------------------

function WardsTab() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [edits, setEdits] = useState<Record<string, { price: string; gst: string }>>({});
  const load = useCallback(() => { fetchWards().then(setWards).catch(reportError); }, []);
  useEffect(load, [load]);

  const save = async (w: Ward) => {
    const e = edits[w.ward] ?? { price: String(w.dailyRate ?? ''), gst: String(w.gstPct ?? 0) };
    const price = num(e.price);
    const gst = num(e.gst);
    if (!(price >= 0) || !(gst >= 0 && gst <= 100)) return reportError(new Error('Enter the daily rate and a GST between 0 and 100'));
    try {
      await saveWardRate(w.ward, price, gst);
      useNoticeStore.getState().show(`${w.ward}: ${rupees(price)} per day saved`, 'info');
      setEdits((prev) => { const { [w.ward]: _, ...rest } = prev; return rest; });
      load();
    } catch (err) {
      reportError(err);
    }
  };

  const missing = wards.filter((w) => w.dailyRate === null).length;
  return (
    <div className="card">
      <h3>Daily bed charge for each ward</h3>
      <div className="card-sub">
        A patient is charged this for each bed day, at the rate of the ward they were in (a bed day ends at the checkout hour set under Hospital settings).
        A ward with no rate set cannot be billed: its stays show a warning on the bill.
      </div>
      {missing > 0 && <div className="drug-flags" style={{ marginBottom: 10 }}><span className="badge warn">{missing} ward{missing === 1 ? ' has' : 's have'} no daily rate yet</span></div>}
      <table className="table">
        <thead><tr><th>Ward</th><th className="num">Beds</th><th className="num">Daily rate (₹)</th><th className="num">GST %</th><th></th></tr></thead>
        <tbody>
          {wards.map((w) => {
            const e = edits[w.ward];
            return (
              <tr key={w.ward}>
                <td><b>{w.ward}</b></td>
                <td className="num">{w.beds}</td>
                <td className="num"><input type="number" min={0} style={{ width: 120, textAlign: 'right' }} value={e?.price ?? (w.dailyRate ?? '')} placeholder="not set"
                  onChange={(ev) => setEdits({ ...edits, [w.ward]: { price: ev.target.value, gst: e?.gst ?? String(w.gstPct ?? 0) } })} /></td>
                <td className="num"><input type="number" min={0} max={100} style={{ width: 80, textAlign: 'right' }} value={e?.gst ?? (w.gstPct ?? 0)}
                  onChange={(ev) => setEdits({ ...edits, [w.ward]: { price: e?.price ?? String(w.dailyRate ?? ''), gst: ev.target.value } })} /></td>
                <td><button className="btn btn-sm btn-primary" disabled={!e} onClick={() => save(w)}>Save</button></td>
              </tr>
            );
          })}
          {wards.length === 0 && <tr><td colSpan={5} className="empty-state">No beds have been added yet. Beds are added in the bed board setup; their wards appear here.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Services ---------------------------------------------------------------------------------------------------------------------

function ServicesTab() {
  const [rows, setRows] = useState<Service[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const load = useCallback(() => { fetchServices({ all: true }).then(setRows).catch(reportError); }, []);
  useEffect(load, [load]);

  const shown = rows.filter((s) => s.category !== 'bed' && (!search || `${s.name} ${s.code}`.toLowerCase().includes(search.toLowerCase())));
  return (
    <div className="card">
      <div className="flex-between">
        <div>
          <h3>Services</h3>
          <div className="card-sub">Nursing, procedures, doctor visits, packages: what the ward or the billing counter can add to an admission</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add a service</button>
      </div>
      <div className="field" style={{ maxWidth: 320 }}><input placeholder="Search by name or code" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <table className="table">
        <thead><tr><th>Code</th><th>Service</th><th>Kind</th><th className="num">Price</th><th className="num">GST</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.code}</td><td>{s.name}</td><td>{SERVICE_CATEGORY_LABEL[s.category]}</td>
              <td className="num mono">{rupees(s.price)}</td><td className="num">{s.gstPct}%</td>
              <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Off</Badge>}</td>
              <td><button className="btn btn-sm" onClick={() => setEditing(s)}>Edit</button></td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={7} className="empty-state">No services yet. Add the ones your hospital charges for.</td></tr>}
        </tbody>
      </table>
      {editing && <ServiceDialog service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function ServiceDialog({ service, onClose, onSaved }: { service: Service | null; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(service?.code ?? '');
  const [name, setName] = useState(service?.name ?? '');
  const [category, setCategory] = useState<ServiceCategory>(service?.category ?? 'nursing');
  const [price, setPrice] = useState(String(service?.price ?? ''));
  const [gst, setGst] = useState(String(service?.gstPct ?? 0));
  const [active, setActive] = useState(service?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = code.trim().length < 2 || name.trim().length < 2 || !(num(price) >= 0) || !(num(gst) >= 0 && num(gst) <= 100);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const body = { code, name, category, price: num(price), gstPct: num(gst), active };
      if (service) await updateService(service.id, body);
      else await createService(body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={service ? `Edit ${service.code}` : 'Add a service'} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="two-col">
          <div className="field"><label>Code *</label><input value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} placeholder="e.g. NUR-IV" autoFocus /></div>
          <div className="field">
            <label>Kind</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as ServiceCategory)}>
              {(Object.keys(SERVICE_CATEGORY_LABEL) as ServiceCategory[]).filter((c) => c !== 'bed').map((c) => <option key={c} value={c}>{SERVICE_CATEGORY_LABEL[c]}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label>Name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} /></div>
        <div className="two-col">
          <div className="field"><label>Price (₹) *</label><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          <div className="field"><label>GST %</label><input type="number" min={0} max={100} value={gst} onChange={(e) => setGst(e.target.value)} /></div>
        </div>
        <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" style={{ width: 'auto' }} checked={active} onChange={(e) => setActive(e.target.checked)} />Active (can be charged)</label>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Tests ---------------------------------------------------------------------------------------------------------------------------

function TestsTab() {
  const [rows, setRows] = useState<Investigation[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Investigation | 'new' | null>(null);
  const load = useCallback(() => { fetchInvestigations({ all: true }).then(setRows).catch(reportError); }, []);
  useEffect(load, [load]);

  const shown = rows.filter((t) => !search || `${t.name} ${t.code}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="card">
      <div className="flex-between">
        <div>
          <h3>Tests</h3>
          <div className="card-sub">Lab and radiology tests the hospital offers. Orders are priced from here, and a lab test's normal ranges are used on its report.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add a test</button>
      </div>
      <div className="field" style={{ maxWidth: 320 }}><input placeholder="Search by name or code" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <table className="table">
        <thead><tr><th>Code</th><th>Test</th><th>Kind</th><th>Section</th><th className="num">TAT (h)</th><th className="num">Price</th><th className="num">GST</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {shown.map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.code}</td><td>{t.name}</td><td>{t.kind === 'lab' ? 'Lab' : 'Radiology'}</td><td>{t.section ?? '—'}</td>
              <td className="num">{t.tatHours ?? '—'}</td><td className="num mono">{rupees(t.price)}</td><td className="num">{t.gstPct}%</td>
              <td>{t.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Off</Badge>}</td>
              <td><button className="btn btn-sm" onClick={() => setEditing(t)}>Edit</button></td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={9} className="empty-state">No tests yet. Add the ones your lab and imaging offer.</td></tr>}
        </tbody>
      </table>
      {editing && <TestDialog test={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

interface ParamRow { name: string; unit: string; low: string; high: string; text: string; critLow: string; critHigh: string }

function TestDialog({ test, onClose, onSaved }: { test: Investigation | null; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(test?.code ?? '');
  const [name, setName] = useState(test?.name ?? '');
  const [kind, setKind] = useState<'lab' | 'radiology'>(test?.kind ?? 'lab');
  const [section, setSection] = useState(test?.section ?? '');
  const [sample, setSample] = useState(test?.sample ?? '');
  const [tat, setTat] = useState(test?.tatHours != null ? String(test.tatHours) : '');
  const [price, setPrice] = useState(String(test?.price ?? ''));
  const [gst, setGst] = useState(String(test?.gstPct ?? 0));
  const [active, setActive] = useState(test?.active ?? true);
  const [params, setParams] = useState<ParamRow[]>([]);
  const [loaded, setLoaded] = useState(!test);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!test) return;
    fetchInvestigation(test.id).then((d) => {
      setParams(d.parameters.map((p) => ({ name: p.name, unit: p.unit ?? '', low: p.refLow != null ? String(p.refLow) : '', high: p.refHigh != null ? String(p.refHigh) : '', text: p.refText ?? '', critLow: p.criticalLow != null ? String(p.criticalLow) : '', critHigh: p.criticalHigh != null ? String(p.criticalHigh) : '' })));
      setLoaded(true);
    }, reportError);
  }, [test]);

  const setRow = (i: number, change: Partial<ParamRow>) => setParams(params.map((p, j) => (j === i ? { ...p, ...change } : p)));
  const invalid = !loaded || code.trim().length < 2 || name.trim().length < 2 || !(num(price) >= 0) || !(num(gst) >= 0 && num(gst) <= 100) || params.some((p) => !p.name.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const body: InvestigationInput = {
        code, name, kind, section: section.trim() || null, sample: sample.trim() || null, tatHours: tat.trim() === '' ? null : Number(tat),
        price: num(price), gstPct: num(gst), active,
        parameters: kind === 'lab' ? params.map((p) => ({ name: p.name.trim(), unit: p.unit.trim() || null, refLow: p.low.trim() === '' ? null : Number(p.low), refHigh: p.high.trim() === '' ? null : Number(p.high), refText: p.text.trim() || null, criticalLow: p.critLow.trim() === '' ? null : Number(p.critLow), criticalHigh: p.critHigh.trim() === '' ? null : Number(p.critHigh) })) : [],
      };
      if (test) await updateInvestigation(test.id, body);
      else await createInvestigation(body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={test ? `Edit ${test.code}` : 'Add a test'} onClose={onClose} width={720}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="two-col">
          <div className="field"><label>Code *</label><input value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} autoFocus /></div>
          <div className="field"><label>Kind</label><select value={kind} onChange={(e) => setKind(e.target.value as 'lab' | 'radiology')}><option value="lab">Lab</option><option value="radiology">Radiology</option></select></div>
        </div>
        <div className="field"><label>Name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} /></div>
        <div className="two-col">
          <div className="field"><label>Section</label><input value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. Haematology" /></div>
          <div className="field"><label>Sample</label><input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="e.g. EDTA blood" /></div>
        </div>
        <div className="two-col">
          <div className="field"><label>Price (₹) *</label><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          <div className="field"><label>GST %</label><input type="number" min={0} max={100} value={gst} onChange={(e) => setGst(e.target.value)} /></div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}><label>Report ready in (hours)</label><input type="number" min={0} value={tat} onChange={(e) => setTat(e.target.value)} /></div>

        {kind === 'lab' && (
          <div style={{ marginTop: 6 }}>
            <label style={{ fontWeight: 600, fontSize: 13 }}>What it measures, and the normal range</label>
            <div className="card-sub">Typical adult ranges are fine to start; use the ranges your own lab reports. Leave the numbers empty and use the text for results such as "Nil". A result beyond the critical limits is flagged critical and a doctor is asked to acknowledge it.</div>
            {params.map((p, i) => (
              <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                <input style={{ flex: 2, minWidth: 140 }} placeholder="Parameter" value={p.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                <input style={{ width: 90 }} placeholder="Unit" value={p.unit} onChange={(e) => setRow(i, { unit: e.target.value })} />
                <input style={{ width: 80 }} type="number" placeholder="Low" value={p.low} onChange={(e) => setRow(i, { low: e.target.value })} />
                <input style={{ width: 80 }} type="number" placeholder="High" value={p.high} onChange={(e) => setRow(i, { high: e.target.value })} />
                <input style={{ flex: 1, minWidth: 100 }} placeholder="or text, e.g. Nil" value={p.text} onChange={(e) => setRow(i, { text: e.target.value })} />
                <input style={{ width: 80 }} type="number" placeholder="Crit. low" title="Below this the result is flagged critical" value={p.critLow} onChange={(e) => setRow(i, { critLow: e.target.value })} />
                <input style={{ width: 80 }} type="number" placeholder="Crit. high" title="Above this the result is flagged critical" value={p.critHigh} onChange={(e) => setRow(i, { critHigh: e.target.value })} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove parameter" onClick={() => setParams(params.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setParams([...params, { name: '', unit: '', low: '', high: '', text: '', critLow: '', critHigh: '' }])}>+ Add a parameter</button>
          </div>
        )}

        <label className="row" style={{ cursor: 'pointer', marginTop: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={active} onChange={(e) => setActive(e.target.checked)} />Active (can be ordered)</label>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Prescription templates ------------------------------------------------------------------------------------------------------------

function TemplatesTab() {
  const [rows, setRows] = useState<RxTemplate[]>([]);
  const [editing, setEditing] = useState<RxTemplate | 'new' | null>(null);
  const load = useCallback(() => { fetchTemplates().then(setRows).catch(reportError); }, []);
  useEffect(load, [load]);

  const remove = async (t: RxTemplate) => {
    if (!window.confirm(`Delete the template "${t.name}"?`)) return;
    try { await deleteTemplate(t.id); load(); } catch (err) { reportError(err); }
  };

  return (
    <div className="card">
      <div className="flex-between">
        <div>
          <h3>Prescription templates</h3>
          <div className="card-sub">Saved sets of medicines a doctor can drop into a prescription. Templates marked "Shared" are available to every doctor; the doctor still reviews each line.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add a template</button>
      </div>
      <table className="table">
        <thead><tr><th>Name</th><th>For</th><th>Medicines</th><th>Available to</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b></td><td>{t.diagnosis ?? '—'}</td>
              <td style={{ fontSize: 12.5 }}>{t.items.map((i) => `${i.drugName} ${i.dose} ${i.frequency} × ${i.duration}`).join('; ')}</td>
              <td>{t.shared ? <Badge tone="brand">Shared</Badge> : <Badge tone="neutral">{t.ownerName ?? 'One doctor'}</Badge>}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={() => setEditing(t)}>Edit</button><button className="btn btn-sm btn-danger" onClick={() => remove(t)}>Delete</button></div></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="empty-state">No templates yet.</td></tr>}
        </tbody>
      </table>
      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

const blankItem: TemplateItem = { drugName: '', dose: '', frequency: '', duration: '' };

export function TemplateDialog({ template, initial, onClose, onSaved }: { template: RxTemplate | null; initial?: { diagnosis?: string; items?: TemplateItem[] }; onClose: () => void; onSaved: () => void }) {
  const role = useHospitalStore((s) => s.currentRole);
  const [name, setName] = useState(template?.name ?? '');
  const [diagnosis, setDiagnosis] = useState(template?.diagnosis ?? initial?.diagnosis ?? '');
  const [items, setItems] = useState<TemplateItem[]>(template?.items ?? initial?.items ?? [{ ...blankItem }]);
  const [shared, setShared] = useState(template?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = name.trim().length < 2 || items.length === 0 || items.some((i) => !i.drugName.trim() || !i.dose.trim() || !i.frequency.trim() || !i.duration.trim());
  const setItem = (i: number, change: Partial<TemplateItem>) => setItems(items.map((x, j) => (j === i ? { ...x, ...change } : x)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await saveTemplate({ name, diagnosis: diagnosis.trim() || null, items, shared }, template?.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={template ? 'Edit template' : 'Save as a template'} onClose={onClose} width={680}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="two-col">
          <div className="field"><label>Template name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Viral fever" /></div>
          <div className="field"><label>For (diagnosis)</label><input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} maxLength={200} /></div>
        </div>
        {items.map((item, i) => (
          <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
            <input style={{ flex: 2, minWidth: 160 }} placeholder="Medicine" value={item.drugName} onChange={(e) => setItem(i, { drugName: e.target.value })} />
            <input style={{ flex: 1, minWidth: 90 }} placeholder="Dose" value={item.dose} onChange={(e) => setItem(i, { dose: e.target.value })} />
            <input style={{ width: 100 }} placeholder="Frequency" value={item.frequency} onChange={(e) => setItem(i, { frequency: e.target.value })} />
            <input style={{ width: 110 }} placeholder="Duration" value={item.duration} onChange={(e) => setItem(i, { duration: e.target.value })} />
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove medicine" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setItems([...items, { ...blankItem }])}>+ Add a medicine</button>
        {role === 'admin' && (
          <label className="row" style={{ cursor: 'pointer', marginTop: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={shared} onChange={(e) => setShared(e.target.checked)} />Share with every doctor</label>
        )}
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save template'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Settings ---------------------------------------------------------------------------------------------------------------------------

function SettingsTab() {
  const [settings, setSettings] = useState<HospitalSettings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSettings().then((s) => {
      setSettings(s);
      setForm(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)])));
    }, reportError);
  }, []);

  if (!settings) return <div className="card"><div className="empty-state">Loading…</div></div>;
  const set = (key: keyof HospitalSettings) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const numeric = ['opdDefaultFee', 'erFee', 'unlistedTestPrice', 'unlistedMedicinePrice', 'medicineGstPct', 'bedDayCheckoutHour'] as const;
      const change: Record<string, string | number | boolean> = {};
      for (const key of Object.keys(settings) as (keyof HospitalSettings)[]) {
        const value = form[key] ?? '';
        if (key === 'requireReportVerification') { if ((value === 'true') !== settings[key]) change[key] = value === 'true'; continue; }
        if ((numeric as readonly string[]).includes(key)) { if (Number(value) !== settings[key]) change[key] = Number(value); }
        else if (value !== settings[key]) change[key] = value;
      }
      const saved = await saveSettings(change);
      setSettings(saved);
      setForm(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, String(v)])));
      useNoticeStore.getState().show('Settings saved', 'info');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={save}>
      <h3>Hospital settings</h3>
      <div className="card-sub">Used on bills and printed forms, and as the defaults when no specific price is set.</div>
      <div className="two-col">
        <div className="field"><label>GSTIN</label><input value={form.gstin ?? ''} onChange={set('gstin')} maxLength={15} placeholder="e.g. 27ABCDE1234F1Z5" /></div>
        <div className="field"><label>Registration number</label><input value={form.registrationNo ?? ''} onChange={set('registrationNo')} maxLength={60} placeholder="Clinical establishment / state registration" /></div>
      </div>
      <div className="field" style={{ maxWidth: 380 }}><label>Pharmacy drug licence number</label><input value={form.drugLicenseNo ?? ''} onChange={set('drugLicenseNo')} maxLength={60} /><div className="ai-hint">Printed on pharmacy invoices.</div></div>
      <div className="two-col">
        <div className="field"><label>Standard OPD consultation fee (₹)</label><input type="number" min={0} value={form.opdDefaultFee ?? ''} onChange={set('opdDefaultFee')} /><div className="ai-hint">For a doctor who has no fee of their own.</div></div>
        <div className="field"><label>Emergency consultation fee (₹)</label><input type="number" min={0} value={form.erFee ?? ''} onChange={set('erFee')} /></div>
      </div>
      <div className="two-col">
        <div className="field"><label>Test not on the list: price (₹)</label><input type="number" min={0} value={form.unlistedTestPrice ?? ''} onChange={set('unlistedTestPrice')} /></div>
        <div className="field"><label>Medicine not in stock list: price per unit (₹)</label><input type="number" min={0} value={form.unlistedMedicinePrice ?? ''} onChange={set('unlistedMedicinePrice')} /></div>
      </div>
      <div className="two-col">
        <div className="field"><label>GST on a medicine not in the stock list (%)</label><input type="number" min={0} max={100} value={form.medicineGstPct ?? ''} onChange={set('medicineGstPct')} /></div>
        <div className="field"><label>Bed day ends at (hour, 0-23)</label><input type="number" min={0} max={23} value={form.bedDayCheckoutHour ?? ''} onChange={set('bedDayCheckoutHour')} /><div className="ai-hint">12 means a patient still in on a later date at 12 noon is charged another day.</div></div>
      </div>
      <label className="row" style={{ cursor: 'pointer', margin: '4px 0 12px' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.requireReportVerification === 'true'} onChange={(e) => setForm({ ...form, requireReportVerification: String(e.target.checked) })} />
        <span>Lab and radiology reports need a second person to sign them <span className="ai-hint">(not the person who entered the results)</span></span>
      </label>
      <div className="field"><label>Line at the foot of bills and receipts</label><input value={form.billFooter ?? ''} onChange={set('billFooter')} maxLength={200} /></div>
      <div className="field">
        <label>Consent wording on the admission form</label>
        <textarea rows={6} value={form.consentText ?? ''} onChange={set('consentText')} />
        <div className="ai-hint">This is a general template. Have your own legal adviser review the wording before you rely on it.</div>
      </div>
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
    </form>
  );
}

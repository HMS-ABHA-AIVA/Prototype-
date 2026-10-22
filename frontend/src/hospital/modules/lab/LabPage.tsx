import { useCallback, useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import * as lab from '../../api/lab';
import { STATUS_LABEL, STATUS_TONE } from '../../api/lab';
import { when } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { useHospitalStore } from '../../store/useHospitalStore';
import { reportError } from '../../store/useNoticeStore';
import type { Role } from '../../types';
import { InvoicesTab, NewTestsTab } from './LabDesk';
import { ReportDialog } from './LabReport';
import { MisTab } from './LabMis';
import { WorkDialog } from './LabWork';

type Tab = 'worklist' | 'new' | 'invoices' | 'mis';
const TAB_LABEL: Record<Tab, string> = { worklist: 'Worklist', new: 'Tests for a patient', invoices: 'Lab invoices', mis: 'Figures' };
const TAB_ROLES: Record<Tab, Role[]> = {
  worklist: ['lab', 'nurse', 'doctor', 'admin'],
  new: ['lab', 'front_office', 'biller', 'admin'],
  invoices: ['lab', 'front_office', 'biller', 'admin'],
  mis: ['lab', 'admin'],
};

/**
 * Laboratory and radiology: the worklist of tests to collect, enter and sign, with the work of each in a dialog; tests for a patient who has come
 * only for tests (with their invoice); the invoices; and the management figures. Each role sees only the tabs it may use.
 */
export function LabPage() {
  const role = useHospitalStore((s) => s.currentRole);
  const tabs = (Object.keys(TAB_ROLES) as Tab[]).filter((t) => TAB_ROLES[t].includes(role));
  // The chosen tab, unless this role may not use it (the role can arrive just after the screen first draws).
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab = chosen && tabs.includes(chosen) ? chosen : (tabs[0] ?? 'worklist');
  const setTab = setChosen;
  const [bump, setBump] = useState(0);

  if (!apiEnabled) return <div className="card"><h3>Lab & Radiology</h3><div className="card-sub">This screen needs the backend (VITE_API_URL).</div></div>;
  return (
    <>
      <div className="os-head">
        <div>
          <h1>Lab & Radiology</h1>
          <div className="sub">Samples, results and signed reports; tests for patients who come only for tests</div>
        </div>
      </div>
      <div className="tabs">
        {tabs.map((t) => <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{TAB_LABEL[t]}</div>)}
      </div>
      {tab === 'worklist' && <WorklistTab key={bump} />}
      {tab === 'new' && <NewTestsTab onDone={() => { setBump(bump + 1); }} />}
      {tab === 'invoices' && <InvoicesTab canCancel={role === 'biller' || role === 'admin'} />}
      {tab === 'mis' && <MisTab />}
    </>
  );
}

type View = 'open' | 'resulted' | 'overdue' | 'completed' | 'all';
const VIEWS: [View, string][] = [['open', 'To do'], ['resulted', 'Awaiting signature'], ['overdue', 'Overdue'], ['completed', 'Reported'], ['all', 'Everything']];

function WorklistTab() {
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<'' | 'lab' | 'radiology'>('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<{ orders: lab.WorkRow[]; counts: lab.WorkCounts } | null>(null);
  const [critical, setCritical] = useState<Awaited<ReturnType<typeof lab.fetchCritical>>>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  const load = useCallback(() => {
    lab.fetchWorklist({ status: view === 'overdue' ? 'open' : view, overdue: view === 'overdue', ...(kind ? { kind } : {}), search }).then(setData, reportError);
    lab.fetchCritical().then(setCritical, () => undefined);
  }, [view, kind, search]);
  useEffect(() => {
    const first = setTimeout(load, 150);
    const timer = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [load]);

  const c = data?.counts;
  return (
    <>
      {critical.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--danger)' }}>
          <h3 style={{ color: 'var(--danger)' }}>Critical results not yet acknowledged by a doctor</h3>
          {critical.slice(0, 6).map((r) => (
            <div key={r.id} className="flex-between" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span><b>{r.patientName}</b> <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{r.mrn}</span> · {r.name} · reported {when(r.signedAt)}{r.orderedBy ? ` · ordered by ${r.orderedBy}` : ''}</span>
              <button className="btn btn-sm btn-primary" onClick={() => setReading(r.id)}>Open report</button>
            </div>
          ))}
          {critical.length > 6 && <div className="rx-small" style={{ marginTop: 6 }}>and {critical.length - 6} more</div>}
        </div>
      )}
      <div className="kpi-row">
        <div className="kpi"><div className="label">Waiting for the sample</div><div className="value">{c?.ordered ?? '–'}</div><div className="sub">ordered, not yet collected</div></div>
        <div className="kpi"><div className="label">In progress</div><div className="value">{c?.inProgress ?? '–'}</div><div className="sub">collected, results not entered</div></div>
        <div className="kpi"><div className="label">Awaiting signature</div><div className="value">{c?.awaitingSignature ?? '–'}</div><div className="sub">results entered</div></div>
        <div className="kpi" style={{ borderBottomColor: (c?.overdue ?? 0) > 0 ? 'var(--danger)' : 'var(--brand)' }}><div className="label">Overdue</div><div className="value">{c?.overdue ?? '–'}</div><div className="sub">past the hours promised</div></div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {VIEWS.map(([v, label]) => <div key={v} className={`tab${view === v ? ' active' : ''}`} onClick={() => setView(v)}>{label}</div>)}
          </div>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={{ maxWidth: 150 }}><option value="">Lab and radiology</option><option value="lab">Lab</option><option value="radiology">Radiology</option></select>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Patient, MRN, test or sample no." style={{ maxWidth: 260 }} />
        </div>
        <table className="table">
          <thead><tr><th>Patient</th><th>Test</th><th>No.</th><th>Ordered</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data?.orders.map((o) => (
              <tr key={o.id} style={o.overdue ? { background: 'var(--danger-soft)' } : undefined}>
                <td><b>{o.patientName}</b><div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{o.mrn}</div></td>
                <td>{o.name}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{[o.kind === 'radiology' ? 'Radiology' : o.section, o.sample].filter(Boolean).join(' · ')}</div></td>
                <td className="mono">{o.accessionNo ?? '—'}</td>
                <td>{when(o.createdAt)}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{o.invoiceNo ? `Lab desk ${o.invoiceNo}` : [o.encounterType, o.department].filter(Boolean).join(' · ')}{o.orderedBy ? ` · ${o.orderedBy}` : ''}</div></td>
                <td>
                  <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                  {o.overdue && <> <Badge tone="danger">Overdue</Badge></>}
                  {o.critical && o.status === 'completed' && !o.criticalAckAt && <> <Badge tone="danger">Critical</Badge></>}
                  {o.amendedCount > 0 && <> <Badge tone="warn">Amended</Badge></>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {o.status === 'completed' && <button className="btn btn-sm" onClick={() => setReading(o.id)}>Report</button>}{' '}
                  {o.status !== 'cancelled' && <button className="btn btn-sm btn-primary" onClick={() => setWorking(o.id)}>{o.status === 'ordered' ? (o.kind === 'lab' ? 'Collect' : 'Start') : o.status === 'completed' ? 'Open' : 'Enter / sign'}</button>}
                </td>
              </tr>
            ))}
            {data && data.orders.length === 0 && <tr><td colSpan={6} className="empty-state">{view === 'open' ? 'Nothing waiting. New tests appear here as doctors order them.' : 'Nothing to show.'}</td></tr>}
            {!data && <tr><td colSpan={6} className="empty-state">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {working && <WorkDialog orderId={working} onClose={() => { setWorking(null); load(); }} onChanged={load} />}
      {reading && <ReportDialog orderId={reading} onClose={() => setReading(null)} onChanged={load} />}
    </>
  );
}

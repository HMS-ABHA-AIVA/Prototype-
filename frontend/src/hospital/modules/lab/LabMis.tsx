import { useEffect, useState } from 'react';
import * as lab from '../../api/lab';
import { Badge } from '../../components/ui/Badge';
import { reportError } from '../../store/useNoticeStore';
import { rupees } from '../opdbilling/BillingFields';

const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86_400_000).toISOString().slice(0, 10);
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);

/** Lab and radiology management figures: volumes, turnaround against what each test promises, what is pending, and the money. */
export function MisTab() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayIst());
  const [kind, setKind] = useState<'' | 'lab' | 'radiology'>('');
  const [data, setData] = useState<lab.Summary | null>(null);
  useEffect(() => { lab.fetchSummary(from, to, kind || undefined).then(setData, reportError); }, [from, to, kind]);

  const t = data?.totals;
  return (
    <>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>Show</label><select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="">Lab and radiology</option><option value="lab">Lab only</option><option value="radiology">Radiology only</option></select></div>
          <div className="rx-small" style={{ color: 'var(--ink-soft)', alignSelf: 'end' }}>By the date the test was ordered.</div>
        </div>
      </div>
      {!data || !t ? <div className="empty-state">Loading…</div> : (
        <>
          <div className="kpi-row">
            <div className="kpi"><div className="label">Tests ordered</div><div className="value">{t.ordered}</div><div className="sub">{t.cancelled} cancelled</div></div>
            <div className="kpi"><div className="label">Reported</div><div className="value">{t.completed}</div><div className="sub">{t.amended} amended after release</div></div>
            <div className="kpi" style={{ borderBottomColor: t.overdue > 0 ? 'var(--danger)' : 'var(--brand)' }}><div className="label">Pending</div><div className="value">{t.pending}</div><div className="sub">{t.overdue} overdue</div></div>
            <div className="kpi" style={{ borderBottomColor: t.criticalWaiting > 0 ? 'var(--danger)' : 'var(--brand)' }}><div className="label">Critical results</div><div className="value">{t.critical}</div><div className="sub">{t.criticalWaiting} waiting for a doctor to acknowledge</div></div>
            <div className="kpi"><div className="label">Collected at the lab desk</div><div className="value">{rupees(data.desk.total)}</div><div className="sub">{data.desk.count} invoice(s), {data.desk.cancelled} cancelled</div></div>
          </div>

          <div className="card">
            <h3>By section</h3>
            <table className="table">
              <thead><tr><th>Section</th><th className="num">Ordered</th><th className="num">Reported</th><th className="num">Value at list price (visits)</th><th className="num">Collected at the lab desk</th></tr></thead>
              <tbody>
                {data.sections.map((s) => <tr key={s.section}><td>{s.section}</td><td className="num">{s.ordered}</td><td className="num">{s.completed}</td><td className="num mono">{rupees(s.visitValue)}</td><td className="num mono">{rupees(s.deskCollected)}</td></tr>)}
                {data.sections.length === 0 && <tr><td colSpan={5} className="empty-state">No tests in this period.</td></tr>}
              </tbody>
            </table>
            <div className="rx-small" style={{ color: 'var(--ink-soft)', marginTop: 6 }}>Tests ordered on a visit are billed with the visit (after any panel rate or discount), so for those the figure is the value of the work at list price, not the money collected. The lab-desk figure is exact.</div>
          </div>

          <div className="card">
            <h3>By test</h3>
            <table className="table">
              <thead><tr><th>Test</th><th>Section</th><th className="num">Ordered</th><th className="num">Reported</th><th className="num">Average time</th><th className="num">Promised</th><th className="num">Within the promise</th></tr></thead>
              <tbody>
                {data.tests.map((x) => (
                  <tr key={`${x.investigationId ?? x.name}`}>
                    <td>{x.name}{x.investigationId === null && <span className="rx-small" style={{ color: 'var(--ink-soft)' }}> (not on the list)</span>}</td>
                    <td>{x.section ?? '—'}</td><td className="num">{x.ordered}</td><td className="num">{x.completed}</td>
                    <td className="num">{hours(x.avgTatHours)}</td><td className="num">{x.tatHours != null ? `${x.tatHours} h` : '—'}</td>
                    <td className="num">{x.withinTargetPct === null ? '—' : <Badge tone={x.withinTargetPct >= 90 ? 'ok' : x.withinTargetPct >= 70 ? 'warn' : 'danger'}>{x.withinTargetPct}%</Badge>}</td>
                  </tr>
                ))}
                {data.tests.length === 0 && <tr><td colSpan={7} className="empty-state">No tests in this period.</td></tr>}
              </tbody>
            </table>
            <div className="rx-small" style={{ color: 'var(--ink-soft)', marginTop: 6 }}>Time is counted from the sample being collected (or the order, if no sample yet) to the report being signed.</div>
          </div>
        </>
      )}
    </>
  );
}

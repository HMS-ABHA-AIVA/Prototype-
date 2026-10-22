import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiEnabled } from '../../api/client';
import * as pharmacy from '../../api/pharmacy';
import { when } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { ReasonDialog } from '../ipdbilling/IpdBillDialogs';
import type { Prescription } from '../../types';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const FREQUENCY_TIMES: Record<string, string> = { OD: '09:00', QD: '09:00', HS: '22:00', BD: '09:00, 21:00', BID: '09:00, 21:00', TDS: '08:00, 14:00, 20:00', TID: '08:00, 14:00, 20:00', QID: '06:00, 12:00, 18:00, 22:00' };

const STATUS_TONE = { due: 'warn', given: 'ok', missed: 'danger', held: 'neutral' } as const;

/** One dose with its buttons: given, missed or held (the last two need a reason). */
function DoseRow({ dose, showPatient, onChanged }: { dose: pharmacy.Dose; showPatient: boolean; onChanged: () => void }) {
  const [asking, setAsking] = useState<'miss' | 'hold' | null>(null);
  const [busy, setBusy] = useState(false);
  const overdue = dose.status === 'due' && new Date(dose.dueAt).getTime() < Date.now() - 10 * 60_000;

  const give = async () => {
    setBusy(true);
    try {
      await pharmacy.actOnDose(dose.id, 'give');
      useNoticeStore.getState().show(`${dose.drugName} given to ${dose.patientName}`, 'info');
      onChanged();
    } catch (err) {
      reportError(err);
      setBusy(false);
    }
  };

  return (
    <tr style={overdue ? { background: 'var(--danger-soft)' } : undefined}>
      <td className="mono"><b>{clock(dose.dueAt)}</b>{overdue && <div><Badge tone="danger">Overdue</Badge></div>}</td>
      {showPatient && <td><b>{dose.patientName}</b><div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{dose.bed ?? '—'} · {dose.mrn}</div></td>}
      <td>{dose.drugName}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{dose.dose} · {dose.frequency}{dose.instructions ? ` · ${dose.instructions}` : ''}</div></td>
      <td>
        {dose.status === 'due' ? (
          <div className="row">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={give}>Given</button>
            <button className="btn btn-sm" onClick={() => setAsking('miss')}>Missed</button>
            <button className="btn btn-sm" onClick={() => setAsking('hold')}>Hold</button>
          </div>
        ) : (
          <span><Badge tone={STATUS_TONE[dose.status]}>{dose.status}</Badge> <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{dose.actedBy} {dose.actedAt ? clock(dose.actedAt) : ''}{dose.note ? ` · ${dose.note}` : ''}</span></span>
        )}
      </td>
      {asking && (
        <ReasonDialog
          title={asking === 'miss' ? 'Dose missed' : 'Hold this dose'} prompt={asking === 'miss' ? 'Why was the dose missed? *' : 'Why is it being held? *'} confirmLabel="Save"
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => { await pharmacy.actOnDose(dose.id, asking, reason); setAsking(null); onChanged(); }}
        />
      )}
    </tr>
  );
}

/** The nurse's round: every dose due in the next few hours across the ward, overdue ones marked. */
export function MedicineRoundPage() {
  const [hours, setHours] = useState(4);
  const [doses, setDoses] = useState<pharmacy.Dose[] | null>(null);
  const load = useCallback(() => { pharmacy.fetchDueDoses(hours).then(setDoses, reportError); }, [hours]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!apiEnabled) return <div className="card"><h3>Medicine round</h3><div className="card-sub">The ward medicine schedule needs the backend (VITE_API_URL).</div></div>;
  const overdue = (doses ?? []).filter((d) => new Date(d.dueAt).getTime() < Date.now() - 10 * 60_000).length;
  return (
    <>
      <div className="os-head">
        <div>
          <h1>Medicine round</h1>
          <div className="sub">Doses due for admitted patients · {overdue > 0 ? <b style={{ color: 'var(--danger)' }}>{overdue} overdue</b> : 'none overdue'}</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Show the next</label>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hours</option>)}</select>
        </div>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>Due</th><th>Patient</th><th>Medicine</th><th></th></tr></thead>
          <tbody>
            {doses?.map((d) => <DoseRow key={d.id} dose={d} showPatient onChanged={load} />)}
            {doses && doses.length === 0 && <tr><td colSpan={4} className="empty-state">No doses are due in the next {hours} hours. Schedule a prescription from the patient's file (Nursing Station).</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Schedules a prescription: the times of day and, optionally, how many days. The pharmacy then sees how many units the course needs. */
function ScheduleDialog({ encounterId, rx, onClose, onDone }: { encounterId: string; rx: Prescription; onClose: () => void; onDone: () => void }) {
  const initial = FREQUENCY_TIMES[rx.frequency.trim().toUpperCase()] ?? '';
  const [times, setTimes] = useState(initial);
  const [days, setDays] = useState(/(\d+)\s*day/i.exec(rx.duration)?.[1] ?? '');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = times.split(/[,\s]+/).filter(Boolean);
  const invalid = list.length === 0 || list.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || (days.trim() !== '' && !(Number(days) >= 1 && Number(days) <= 60));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await pharmacy.createSchedule(encounterId, { prescriptionId: rx.id, times: list, ...(days.trim() ? { days: Math.floor(Number(days)) } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the schedule');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Schedule ${rx.drugName}`} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <p style={{ fontSize: 13 }}>{rx.dose} · {rx.frequency} · {rx.duration}</p>
        <div className="field"><label>Times of day *</label><input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="08:00, 14:00, 20:00" autoFocus /><div className="ai-hint">24-hour times, separated by commas.</div></div>
        <div className="two-col">
          <div className="field"><label>For how many days</label><input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} placeholder="until stopped" /></div>
          <div className="field"><label>Instructions</label><input value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={200} placeholder="e.g. after food" /></div>
        </div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Set the schedule'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** One admitted patient's medicine schedule: which prescriptions are scheduled, and the doses for the next day. */
export function PatientMedicinePanel({ encounterId, prescriptions }: { encounterId: string; prescriptions: Prescription[] }) {
  const [data, setData] = useState<{ schedules: pharmacy.Schedule[]; doses: pharmacy.Dose[] } | null>(null);
  const [scheduling, setScheduling] = useState<Prescription | null>(null);
  const load = useCallback(() => { pharmacy.fetchWardMedicine(encounterId).then(setData, reportError); }, [encounterId]);
  useEffect(() => { load(); }, [load, prescriptions.length]);

  if (!apiEnabled) return null;
  const active = new Map((data?.schedules ?? []).filter((s) => s.status === 'active').map((s) => [s.prescriptionId, s]));
  const stop = async (s: pharmacy.Schedule) => {
    if (!window.confirm(`Stop the schedule for ${s.drugName}? Doses not yet due are removed.`)) return;
    try { await pharmacy.stopSchedule(s.id); load(); } catch (err) { reportError(err); }
  };

  return (
    <div className="card">
      <div className="flex-between"><div><h3>Medicine schedule</h3><div className="card-sub">When each medicine is due. Doses appear on the <Link to="/medication-round">medicine round</Link> as their time comes.</div></div></div>
      <table className="table">
        <thead><tr><th>Medicine</th><th>Prescribed</th><th>Schedule</th><th></th></tr></thead>
        <tbody>
          {prescriptions.map((rx) => {
            const s = active.get(rx.id);
            return (
              <tr key={rx.id}>
                <td>{rx.drugName}</td><td>{rx.dose} · {rx.frequency} · {rx.duration}</td>
                <td>{s ? <span>{s.times.join(', ')}{s.endDate ? ` until ${s.endDate}` : ''}</span> : <span style={{ color: 'var(--ink-soft)' }}>Not scheduled</span>}</td>
                <td>{s ? <button className="btn btn-sm btn-ghost" onClick={() => stop(s)}>Stop</button> : <button className="btn btn-sm" onClick={() => setScheduling(rx)}>Schedule</button>}</td>
              </tr>
            );
          })}
          {prescriptions.length === 0 && <tr><td colSpan={4} className="empty-state">No medicines have been prescribed.</td></tr>}
        </tbody>
      </table>
      {data && data.doses.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 4px' }}>Doses (yesterday to tomorrow)</h4>
          <table className="table">
            <thead><tr><th>Time</th><th>Medicine</th><th></th></tr></thead>
            <tbody>
              {data.doses.map((d) => (
                <DoseRow key={d.id} dose={d} showPatient={false} onChanged={load} />
              ))}
            </tbody>
          </table>
          <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>Times shown are today and tomorrow ({when(data.doses[0]!.dueAt)} onwards).</div>
        </>
      )}
      {scheduling && <ScheduleDialog encounterId={encounterId} rx={scheduling} onClose={() => setScheduling(null)} onDone={() => { setScheduling(null); load(); }} />}
    </div>
  );
}

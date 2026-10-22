import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiEnabled } from '../../api/client';
import { clearReservation, reserveBed } from '../../api/ipd';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { reportError } from '../../store/useNoticeStore';
import { useRefresh } from '../../store/useRefresh';
import type { Bed, BedStatus } from '../../types';

const STATUS_LABEL: Record<BedStatus, string> = {
  occupied: 'Occupied',
  dirty: 'Dirty',
  cleaning: 'Cleaning',
  vacant: 'Vacant & Ready',
  reserved: 'Reserved',
};

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function BedBoard() {
  const { beds, patients, encounters, currentRole, loadBeds } = useHospitalStore();
  useRefresh(['beds', 'patients', 'encounters'], 20);
  const navigate = useNavigate();
  const [reserving, setReserving] = useState<Bed | null>(null);
  const mayReserve = apiEnabled && (currentRole === 'front_office' || currentRole === 'nurse' || currentRole === 'admin');

  const wards = Array.from(new Set(beds.map((b) => b.ward)));
  const count = (status: BedStatus) => beds.filter((b) => b.status === status).length;

  function openBed(bed: Bed) {
    if (bed.encounterId) navigate(`/ipd/patient/${bed.encounterId}`);
    else if (mayReserve && (bed.status === 'vacant' || bed.status === 'reserved')) setReserving(bed);
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>IPD / Bed Board</h1>
          <div className="sub">Real-time ward occupancy{mayReserve ? ' · click a vacant bed to reserve it for a patient who is coming' : ''}</div>
        </div>
        <Link to="/housekeeping" className="btn btn-sm">Housekeeping Turnover →</Link>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="label">Occupied</div><div className="value">{count('occupied')}</div></div>
        <div className="kpi"><div className="label">Awaiting Cleaning</div><div className="value">{count('dirty')}</div></div>
        <div className="kpi"><div className="label">Cleaning In Progress</div><div className="value">{count('cleaning')}</div></div>
        <div className="kpi"><div className="label">Reserved</div><div className="value">{count('reserved')}</div></div>
        <div className="kpi"><div className="label">Vacant & Ready</div><div className="value">{count('vacant')}</div></div>
      </div>

      <div className="status-legend" style={{ marginBottom: 16 }}>
        <span className="item"><span className="swatch occupied" /> Occupied</span>
        <span className="item"><span className="swatch dirty" /> Dirty — awaiting cleaning</span>
        <span className="item"><span className="swatch cleaning" /> Cleaning in progress</span>
        <span className="item"><span className="swatch reserved" /> Reserved</span>
        <span className="item"><span className="swatch vacant" /> Vacant & ready</span>
      </div>

      {wards.map((ward) => (
        <div key={ward} className="card">
          <h3>{ward}</h3>
          <div className="bed-grid" style={{ marginTop: 12 }}>
            {beds.filter((b) => b.ward === ward).map((b) => {
              const patient = patients.find((p) => p.id === b.patientId);
              const encounter = encounters.find((e) => e.id === b.encounterId);
              return (
                <div key={b.id} className={`bed-card ${b.status}`} onClick={() => openBed(b)}>
                  <div className="bno">{b.bedNo}</div>
                  <div className="bst">{STATUS_LABEL[b.status]}</div>
                  {patient && <div className="bwho">{patient.name}</div>}
                  {encounter?.admittedAt && (
                    <div className="bwho">since {new Date(encounter.admittedAt).toLocaleDateString('en-IN')}</div>
                  )}
                  {b.status === 'reserved' && (
                    <>
                      <div className="bwho">{b.reservedFor}</div>
                      {b.reservedUntil && <div className="bwho">until {when(b.reservedUntil)}</div>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {reserving && <ReserveDialog bed={reserving} onClose={() => setReserving(null)} onDone={() => { setReserving(null); void loadBeds(); }} />}
    </>
  );
}

/** Keeps a vacant bed for a patient who is coming, or lets go of a reservation. */
function ReserveDialog({ bed, onClose, onDone }: { bed: Bed; onClose: () => void; onDone: () => void }) {
  const { patients } = useHospitalStore();
  const [patientId, setPatientId] = useState('');
  const [name, setName] = useState('');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (bed.status === 'reserved') {
    return (
      <Modal title={`${bed.ward} ${bed.bedNo} is reserved`} onClose={onClose} width={440}>
        <p style={{ fontSize: 13.5 }}>Kept for <b>{bed.reservedFor}</b>{bed.reservedUntil ? <> until {when(bed.reservedUntil)}</> : ''}.{bed.reservedNote ? <> {bed.reservedNote}</> : ''}</p>
        <p className="ai-hint">Admitting that patient to this bed uses the reservation. Anyone else is refused until it is released.</p>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await clearReservation(bed.id); onDone(); } catch (err) { reportError(err); setBusy(false); } }}>Release the reservation</button>
        </div>
      </Modal>
    );
  }

  const invalid = !patientId && name.trim().length < 2;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await reserveBed(bed.id, {
        ...(patientId ? { patientId } : { reservedFor: name.trim() }),
        ...(until ? { until: new Date(until).toISOString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reserve the bed');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Reserve ${bed.ward} ${bed.bedNo}`} onClose={onClose} width={500}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="field">
          <label>For a registered patient</label>
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">— or type a name below —</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.mrn}</option>)}
          </select>
        </div>
        {!patientId && <div className="field"><label>Name of the patient *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Not registered yet" /></div>}
        <div className="two-col">
          <div className="field"><label>Keep it until</label><input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
          <div className="field"><label>Note</label><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Planned surgery Friday" /></div>
        </div>
        <div className="ai-hint">A reserved bed is not offered to other admissions. After the time passes, anyone may take it.</div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Reserve bed'}</button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/ui/Modal';
import { apiEnabled } from '../../api/client';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import type { Encounter } from '../../types';

export function AdmitToIpdModal({
  patientId,
  department,
  sourceEncounterId,
  onClose,
  onAdmitted,
}: {
  patientId: string;
  department: string;
  /** When admitting from an OPD or emergency visit: that visit is closed as admitted and linked to the new stay. */
  sourceEncounterId?: string;
  onClose: () => void;
  /** Called with the new IPD encounter right after admission succeeds, before navigating — e.g. to link a source ER encounter. */
  onAdmitted?: (encounter: Encounter) => void;
}) {
  const { beds, staff, panels, admitPatient, admitFromEncounter } = useHospitalStore();
  useRefresh(['panels']);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  // A vacant bed, or one reserved for this patient (or whose reservation has lapsed).
  const vacantBeds = beds.filter((b) => b.status === 'vacant' || (b.status === 'reserved' && (b.reservedPatientId === patientId || (!!b.reservedUntil && new Date(b.reservedUntil) < new Date()))));
  const [panelId, setPanelId] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const panel = panels.find((p) => p.id === panelId);
  const needsCard = !!panel?.requiresBeneficiaryId && beneficiary.trim().length < 3;
  const [bedId, setBedId] = useState(vacantBeds[0]?.id ?? '');
  const [dept, setDept] = useState(department);
  const doctors = staff.filter((s) => s.role === 'doctor');
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');

  // With a backend the staff and bed lists arrive a moment after the dialog opens.
  useEffect(() => { if (!doctorId && doctors[0]) setDoctorId(doctors[0].id); }, [doctors, doctorId]);
  useEffect(() => { if (!bedId && vacantBeds[0]) setBedId(vacantBeds[0].id); }, [vacantBeds, bedId]);

  async function handleAdmit() {
    if (!bedId || !doctorId || busy || needsCard) return;
    setBusy(true);
    const billing = panelId ? { panelId, beneficiaryId: beneficiary.trim() || undefined } : undefined;
    const encounter = sourceEncounterId
      ? await admitFromEncounter(sourceEncounterId, dept, doctorId, bedId, billing)
      : await admitPatient(patientId, dept, doctorId, bedId, billing);
    setBusy(false);
    if (!encounter) return; // the server refused (for example the bed was just taken); the reason is on screen
    if (!sourceEncounterId) onAdmitted?.(encounter);
    onClose();
    navigate(`/ipd/patient/${encounter.id}`);
  }

  return (
    <Modal title="Admit to IPD" onClose={onClose} width={480}>
      {vacantBeds.length === 0 ? (
        <div className="empty-state">No vacant beds available right now.</div>
      ) : (
        <>
          <div className="field">
            <label>Department</label>
            <input value={dept} onChange={(e) => setDept(e.target.value)} />
          </div>
          <div className="field">
            <label>Attending Doctor</label>
            <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Bed</label>
            <select value={bedId} onChange={(e) => setBedId(e.target.value)}>
              {vacantBeds.map((b) => <option key={b.id} value={b.id}>{b.ward} — {b.bedNo}{b.status === 'reserved' ? ' (reserved)' : ''}</option>)}
            </select>
          </div>
          {apiEnabled && (
            <>
              <div className="field">
                <label>Billing category</label>
                <select value={panelId} onChange={(e) => { setPanelId(e.target.value); setBeneficiary(''); }}>
                  <option value="">Self-pay (standard rates)</option>
                  {panels.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </select>
              </div>
              {panel && <div className="field"><label>{panel.code} beneficiary / card no.{panel.requiresBeneficiaryId ? ' *' : ''}</label><input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} maxLength={60} /></div>}
            </>
          )}
          <div className="flex-between" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !bedId || !doctorId || needsCard} onClick={handleAdmit}>{busy ? 'Admitting…' : 'Confirm Admission'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

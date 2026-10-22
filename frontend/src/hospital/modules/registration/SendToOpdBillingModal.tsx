import { useEffect, useState } from 'react';
import type { ConsultationRequest } from '../../api/opdBilling';
import { ConsultationPicker } from '../../components/shared/ConsultationPicker';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import type { Patient } from '../../types';
import { DEPARTMENTS } from './departments';

/**
 * For a patient who is already registered (a repeat visit, or a patient who asks to see another doctor): choose one or more doctors, one per
 * speciality, and send them to OPD billing. Each doctor is a separate consultation with its own fee, token and appointment slip.
 */
export function SendToOpdBillingModal({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const { registerConsultations, staff, encounters } = useHospitalStore();
  const doctors = staff.filter((s) => s.role === 'doctor');
  // Departments where this patient already has an open consultation cannot be chosen again.
  const blocked = encounters
    .filter((e) => e.patientId === patient.id && e.type === 'OPD' && ['awaiting_payment', 'waiting', 'in_consult'].includes(e.status))
    .map((e) => e.department);

  const firstFree = [...new Set([...DEPARTMENTS, ...doctors.map((d) => d.department)])].find((d) => !blocked.includes(d)) ?? DEPARTMENTS[0]!;
  const [rows, setRows] = useState<ConsultationRequest[]>([{ department: firstFree, doctorId: '' }]);
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<ConsultationRequest[] | null>(null);

  // With a backend the doctors arrive a moment after the dialog opens: fill in the first doctor once they do.
  useEffect(() => {
    setRows((current) => current.map((row) => {
      if (row.doctorId) return row;
      const own = doctors.filter((d) => d.department === row.department);
      return { ...row, doctorId: (own[0] ?? doctors[0])?.id ?? '' };
    }));
    // only when the list of doctors changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctors.length]);

  async function send() {
    if (saving) return;
    setSaving(true);
    const made = await registerConsultations(patient.id, rows);
    setSaving(false);
    if (made) setSent(rows);
  }

  if (sent) {
    return (
      <Modal title="Sent to OPD billing" onClose={onClose} width={480}>
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <div style={{ fontSize: 34 }}>✅</div>
          <h3 style={{ margin: '6px 0' }}>{patient.name}</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
            {sent.length} consultation{sent.length === 1 ? '' : 's'} waiting at OPD billing ({sent.map((r) => r.department).join(', ')}). Collect the fees there:
            each doctor then gets a token and an appointment slip.
          </p>
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Doctors for ${patient.name}`} onClose={onClose} width={620}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
        MRN {patient.mrn}. Choose the doctor for each speciality the patient needs. Each is billed and queued separately.
        {blocked.length > 0 && <> Already open: <b>{[...new Set(blocked)].join(', ')}</b>.</>}
      </p>
      <ConsultationPicker value={rows} onChange={setRows} blocked={blocked} />
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || rows.some((r) => !r.doctorId)} onClick={send}>{saving ? 'Sending…' : 'Send to OPD Billing →'}</button>
      </div>
    </Modal>
  );
}

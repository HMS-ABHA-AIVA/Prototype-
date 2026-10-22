import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useNavigate } from 'react-router-dom';
import type { Gender, Patient } from '../../types';
import { DEPARTMENTS } from './departments';
import { ConsultationPicker } from '../../components/shared/ConsultationPicker';
import type { ConsultationRequest } from '../../api/opdBilling';

/**
 * Registers a new patient (details, then the way to their ABHA). On the Registration screen it carries on to choosing the doctors and sending the visit to OPD
 * billing. On the OPD Billing screen (`onRegistered`) it stops after that and hands the new patient back, so billing can start straight away.
 */
export function NewRegistrationModal({ onClose, onRegistered }: { onClose: () => void; onRegistered?: (patient: Patient) => void }) {
  const { registerPatient, registerConsultations, staff, patients } = useHospitalStore();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender>('M');
  const [phone, setPhone] = useState('');
  const [newPatient, setNewPatient] = useState<Patient | null>(null);
  const [consults, setConsults] = useState<ConsultationRequest[]>([{ department: DEPARTMENTS[0]!, doctorId: '' }]);

  const doctors = staff.filter((s) => s.role === 'doctor');
  const stepsTotal = onRegistered ? 3 : 4;
  const [saving, setSaving] = useState(false);

  // With a backend the doctors arrive a moment after the dialog opens: fill in the first doctor once they do.
  useEffect(() => {
    setConsults((current) => current.map((c) => (c.doctorId ? c : { ...c, doctorId: (doctors.find((d) => d.department === c.department) ?? doctors[0])?.id ?? '' })));
    // only when the list of doctors changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctors.length]);

  async function handleDemographicsNext() {
    if (saving) return;
    setSaving(true);
    const patient = await registerPatient({
      name,
      age: Number(age),
      gender,
      phone,
      allergies: [],
      problemList: [],
      abhaStatus: 'none',
    });
    setSaving(false);
    if (!patient) return; // the server refused (the reason is on screen), so stay on this step
    setNewPatient(patient);
    setStep(1);
  }

  /** Registration is complete: on the OPD Billing screen hand the patient back to start billing; elsewhere choose the doctors. */
  function afterAbha() {
    if (onRegistered && newPatient) {
      // the ABHA step may have linked an ABHA, so pass on the patient as the store now has them
      // the parent decides what comes next (it replaces this dialog), so this does not close itself
      onRegistered(useHospitalStore.getState().patients.find((p) => p.id === newPatient.id) ?? newPatient);
      return;
    }
    setStep(2);
  }

  async function handleCheckIn() {
    if (!newPatient || saving) return;
    setSaving(true);
    const visits = await registerConsultations(newPatient.id, consults);
    setSaving(false);
    if (visits) setStep(3);
  }

  const linkedPatient = newPatient ? patients.find((p) => p.id === newPatient.id) ?? newPatient : null;

  return (
    <Modal title="New Patient Registration" onClose={onClose} width={620}>
      <div className="steps">
        {Array.from({ length: stepsTotal }).map((_, i) => (
          <div key={i} className={`step${i <= step ? ' done' : ''}`} />
        ))}
      </div>

      {step === 0 && (
        <div>
          <div className="field">
            <label>Full Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramesh Gupta" autoFocus />
          </div>
          <div className="two-col">
            <div className="field">
              <label>Age</label>
              <input type="number" value={age} onChange={(e) => setAge(e.target.value)} />
            </div>
            <div className="field">
              <label>Gender</label>
              <select value={gender} onChange={(e) => setGender(e.target.value as Gender)}>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="O">Other</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Mobile Number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" />
          </div>
          <div className="flex-between" style={{ marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!name || !age || !phone || saving} onClick={handleDemographicsNext}>
              {saving ? 'Saving…' : 'Save & Continue to ABHA →'}
            </button>
          </div>
        </div>
      )}

      {/* ABHA: created or linked on the Registration & ABHA screens, against ABDM (the M1 flows). */}
      {step === 1 && newPatient && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
            <b>{newPatient.name}</b> is registered (MRN <span className="mono">{newPatient.mrn}</span>).
          </p>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 14 }}>
            An ABHA (Ayushman Bharat Health Account) is created or linked with ABDM on the Registration &amp; ABHA screen: Aadhaar or mobile OTP,
            ABHA number or address, or Scan &amp; Share at the counter. It can be done now, or at any later visit.
          </p>
          <div className="flex-between" style={{ marginTop: 18 }}>
            <button className="btn" onClick={() => navigate(`/register?patientId=${newPatient.id}`)}>Create or link ABHA now</button>
            <button className="btn btn-primary" onClick={afterAbha}>{onRegistered ? 'Continue to billing →' : 'Continue →'}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          {linkedPatient?.abhaStatus === 'linked' && (
            <div className="card" style={{ background: 'var(--success-soft)', border: '1px solid #86EFAC', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--success)' }}>ABHA linked successfully</div>
              <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>{linkedPatient.abhaNumber} · {linkedPatient.abhaAddress}</div>
            </div>
          )}
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 14 }}>
            Choose the doctor for each speciality the patient needs today; add more doctors if the patient asks. Each doctor is a separate consultation with its own fee, token and
            appointment slip. They go to OPD billing next, and join each doctor's queue once paid.
          </p>
          <ConsultationPicker value={consults} onChange={setConsults} />
          <div className="flex-between" style={{ marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary" disabled={saving || consults.some((c) => !c.doctorId)} onClick={handleCheckIn}>{saving ? 'Sending…' : 'Send to OPD Billing →'}</button>
          </div>
        </div>
      )}

      {step === 3 && newPatient && (
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>✅</div>
          <h3 style={{ marginBottom: 6 }}>{newPatient.name} registered</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>MRN {newPatient.mrn} · {consults.map((c) => c.department).join(', ')}</p>
          <p style={{ fontSize: 13, marginTop: 10 }}>
            <b>Next: OPD billing.</b> Collect the consultation fee{consults.length > 1 ? 's' : ''} in the OPD Billing list on this screen. Each doctor then gets a token and an appointment slip, and the patient joins each doctor's queue.
          </p>
          <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}

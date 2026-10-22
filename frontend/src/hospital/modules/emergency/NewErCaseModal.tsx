import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import type { ArrivalMode, Gender, TriageLevel } from '../../types';

const TRIAGE_OPTIONS: { key: TriageLevel; label: string; desc: string }[] = [
  { key: 'red', label: 'Red — Immediate', desc: 'Life-threatening, needs care now' },
  { key: 'yellow', label: 'Yellow — Urgent', desc: 'Serious, can wait briefly' },
  { key: 'green', label: 'Green — Non-urgent', desc: 'Stable, minor complaint' },
  { key: 'black', label: 'Black — Deceased/Expectant', desc: 'Beyond resuscitation' },
];

export function NewErCaseModal({ onClose }: { onClose: () => void }) {
  const { patients, staff, registerPatient, checkInToEr } = useHospitalStore();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [query, setQuery] = useState('');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender>('M');
  const [phone, setPhone] = useState('');

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [triageLevel, setTriageLevel] = useState<TriageLevel>('yellow');
  const [arrivalMode, setArrivalMode] = useState<ArrivalMode>('walk_in');
  const doctors = staff.filter((s) => s.role === 'doctor');
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return patients.filter((p) => p.name.toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q) || p.phone.includes(q)).slice(0, 6);
  }, [patients, query]);

  const canSubmit = mode === 'existing' ? !!selectedPatientId : name.trim() && age && phone.trim();
  const readyToTriage = canSubmit && chiefComplaint.trim() && doctorId;

  const [busy, setBusy] = useState(false);

  // With a backend the doctors arrive a moment after the dialog opens.
  useEffect(() => { if (!doctorId && doctors[0]) setDoctorId(doctors[0].id); }, [doctors, doctorId]);

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    let patientId = selectedPatientId;
    if (mode === 'new') {
      const patient = await registerPatient({ name, age: Number(age), gender, phone, allergies: [], problemList: [], abhaStatus: 'none' });
      patientId = patient?.id ?? null;
    }
    const encounter = patientId ? await checkInToEr(patientId, chiefComplaint, triageLevel, arrivalMode, doctorId) : null;
    setBusy(false);
    if (!encounter) return; // the server refused; the reason is on screen
    onClose();
    navigate(`/emergency/case/${encounter.id}`);
  }

  return (
    <Modal title="New Emergency Case" onClose={onClose} width={560}>
      <div className="tabs">
        <div className={`tab${mode === 'existing' ? ' active' : ''}`} onClick={() => setMode('existing')}>Existing Patient</div>
        <div className={`tab${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>New Patient</div>
      </div>

      {mode === 'existing' ? (
        <div className="field">
          <label>Search by name, MRN, or mobile</label>
          <input value={query} onChange={(e) => { setQuery(e.target.value); setSelectedPatientId(null); }} placeholder="Start typing…" autoFocus />
          {matches.length > 0 && (
            <div className="stack" style={{ marginTop: 8 }}>
              {matches.map((p) => (
                <label
                  key={p.id}
                  className="row"
                  style={{
                    border: `1px solid ${selectedPatientId === p.id ? 'var(--brand)' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    background: selectedPatientId === p.id ? 'var(--brand-soft)' : 'var(--surface)',
                  }}
                >
                  <input type="radio" style={{ width: 'auto' }} checked={selectedPatientId === p.id} onChange={() => setSelectedPatientId(p.id)} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>MRN {p.mrn} · {p.age}{p.gender} · {p.phone}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="field">
            <label>Full Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Patient name" autoFocus />
          </div>
          <div className="two-col">
            <div className="field"><label>Age</label><input type="number" value={age} onChange={(e) => setAge(e.target.value)} /></div>
            <div className="field">
              <label>Gender</label>
              <select value={gender} onChange={(e) => setGender(e.target.value as Gender)}>
                <option value="M">Male</option><option value="F">Female</option><option value="O">Other</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Mobile Number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile (if known)" />
          </div>
          <p className="sample-note">ABHA creation can be completed later once the patient is stabilized — not required to start emergency care.</p>
        </div>
      )}

      <div className="field" style={{ marginTop: 6 }}>
        <label>Chief Complaint</label>
        <input value={chiefComplaint} onChange={(e) => setChiefComplaint(e.target.value)} placeholder="e.g. Chest pain, road traffic accident, high fever" />
      </div>

      <div className="field">
        <label>Triage Level</label>
        <div className="two-col">
          {TRIAGE_OPTIONS.map((opt) => (
            <label
              key={opt.key}
              className="row"
              style={{
                border: `1px solid ${triageLevel === opt.key ? 'var(--brand)' : 'var(--border)'}`,
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                background: triageLevel === opt.key ? 'var(--brand-soft)' : 'var(--surface)',
              }}
            >
              <input type="radio" name="triage" style={{ width: 'auto' }} checked={triageLevel === opt.key} onChange={() => setTriageLevel(opt.key)} />
              <span className={`triage-swatch ${opt.key}`} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="two-col">
        <div className="field">
          <label>Arrival Mode</label>
          <select value={arrivalMode} onChange={(e) => setArrivalMode(e.target.value as ArrivalMode)}>
            <option value="walk_in">Walk-in</option>
            <option value="ambulance">Ambulance</option>
            <option value="referred_in">Referred from another facility</option>
          </select>
        </div>
        <div className="field">
          <label>Attending Doctor</label>
          <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-between" style={{ marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!readyToTriage} onClick={handleSubmit}>Admit to ER →</button>
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { OrderTestInput } from '../../components/shared/OrderTestInput';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { VitalsForm } from '../../components/shared/VitalsForm';
import { DrugNameInput } from '../../components/shared/DrugNameInput';
import { canOpen } from '../../components/layout/navConfig';
import { AdmitToIpdModal } from '../ipd/AdmitToIpdModal';
import { OrderProgress } from '../lab/OrderProgress';
import type { ErDisposition, TriageLevel } from '../../types';

const TRIAGE_OPTIONS: TriageLevel[] = ['red', 'yellow', 'green', 'black'];
const TRIAGE_LABEL: Record<TriageLevel, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', black: 'Black' };

function timeSince(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function ErCaseView() {
  const { encounterId } = useParams();
  const navigate = useNavigate();
  const {
    encounters,
    patients,
    saveSoapNote,
    addVitals,
    addPrescription,
    addOrder,
    updateTriage,
    resolveErEncounter,
    currentRole,
  } = useHospitalStore();
  useRefresh(['patients', 'encounters', 'staff', 'beds']);

  const encounter = encounters.find((e) => e.id === encounterId);
  const patient = patients.find((p) => p.id === encounter?.patientId);

  const [subjective, setSubjective] = useState(encounter?.soap?.subjective ?? '');
  const [objective, setObjective] = useState(encounter?.soap?.objective ?? '');
  const [assessment, setAssessment] = useState(encounter?.soap?.assessment ?? '');
  const [plan, setPlan] = useState(encounter?.soap?.plan ?? '');

  const [drugName, setDrugName] = useState('');
  const [dose, setDose] = useState('');
  const [orderType, setOrderType] = useState<'lab' | 'radiology'>('lab');
  const [orderName, setOrderName] = useState('');
  const [orderTestId, setOrderTestId] = useState<string | undefined>(undefined);

  const [showAdmit, setShowAdmit] = useState(false);
  const [dispositionModal, setDispositionModal] = useState<ErDisposition | null>(null);

  // With a backend the case may arrive after the page opens: fill the note boxes once it does.
  useEffect(() => {
    setSubjective(encounter?.soap?.subjective ?? '');
    setObjective(encounter?.soap?.objective ?? '');
    setAssessment(encounter?.soap?.assessment ?? '');
    setPlan(encounter?.soap?.plan ?? '');
    // only when a different case is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter?.id]);

  if (!encounter || !patient) {
    return <div className="empty-state">ER case not found.</div>;
  }

  const enc = encounter;
  const resolved = enc.status !== 'in_er';

  function handleSaveSoap() {
    saveSoapNote(enc.id, { subjective, objective, assessment, plan });
  }

  function handleAddPrescription() {
    if (!drugName || !dose) return;
    addPrescription(enc.id, { drugName, dose, frequency: 'STAT', duration: 'ER' });
    setDrugName('');
    setDose('');
  }

  function handleAddOrder() {
    if (!orderName) return;
    addOrder(enc.id, { type: orderType, name: orderName, investigationId: orderTestId });
    setOrderName('');
    setOrderTestId(undefined);
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>{patient.name} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 16 }}>· ER</span></h1>
          <div className="sub">
            {patient.age}{patient.gender} · MRN {patient.mrn} · {enc.chiefComplaint} · in ER {timeSince(enc.createdAt)}
            {patient.allergies.length > 0 && <> · <Badge tone="danger">Allergy: {patient.allergies.join(', ')}</Badge></>}
          </div>
        </div>
        <Link to={`/emr/${patient.id}`} className="btn btn-sm">Full EMR Chart</Link>
      </div>

      <div className="card">
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="row">
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)' }}>TRIAGE:</span>
            {TRIAGE_OPTIONS.map((t) => (
              <button
                key={t}
                disabled={resolved}
                className={`btn btn-sm${enc.triageLevel === t ? ' btn-primary' : ''}`}
                onClick={() => updateTriage(enc.id, t)}
              >
                <span className={`triage-swatch ${t}`} /> {TRIAGE_LABEL[t]}
              </button>
            ))}
          </div>
          {resolved ? (
            <Badge tone={enc.status === 'deceased' ? 'black' : enc.status === 'referred' ? 'info' : enc.status === 'lama' ? 'neutral' : 'ok'}>
              {enc.status === 'admitted' ? 'Admitted to IPD' : enc.status.charAt(0).toUpperCase() + enc.status.slice(1)}
            </Badge>
          ) : (
            <Badge tone="warn">Active in ER</Badge>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h3>Diagnosis & Treatment Notes</h3>
            <div className="card-sub">Structured clinical documentation for this ER visit</div>
            <div className="field">
              <label>Subjective / History</label>
              <textarea rows={2} value={subjective} onChange={(e) => setSubjective(e.target.value)} disabled={resolved} placeholder="History of presenting complaint…" />
            </div>
            <div className="field">
              <label>Objective / Examination</label>
              <textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} disabled={resolved} placeholder="Exam findings…" />
            </div>
            <div className="field">
              <label>Assessment / Diagnosis</label>
              <textarea rows={2} value={assessment} onChange={(e) => setAssessment(e.target.value)} disabled={resolved} placeholder="Working diagnosis…" />
            </div>
            <div className="field">
              <label>Treatment Plan</label>
              <textarea rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} disabled={resolved} placeholder="Immediate treatment given / plan…" />
            </div>
            {!resolved && <button className="btn btn-primary btn-sm" onClick={handleSaveSoap}>Save Note</button>}
          </div>

          <div className="card">
            <h3>Medications Given</h3>
            {!resolved && (
              <>
                <div className="two-col">
                  <div className="field"><label>Drug Name</label><DrugNameInput value={drugName} onChange={setDrugName} placeholder="e.g. Aspirin 300mg" encounterId={enc.id} /></div>
                  <div className="field"><label>Dose</label><input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="e.g. 1 tab STAT" /></div>
                </div>
                <button className="btn btn-sm" onClick={handleAddPrescription}>+ Add Medication</button>
              </>
            )}
            <table className="table" style={{ marginTop: 12 }}>
              <tbody>
                {enc.prescriptions.map((rx) => (
                  <tr key={rx.id}>
                    <td style={{ fontWeight: 500 }}>{rx.drugName}</td>
                    <td>{rx.dose} · {rx.frequency}</td>
                    <td>{rx.dispensed ? <Badge tone="ok">Dispensed</Badge> : <Badge tone="neutral">Pending</Badge>}</td>
                  </tr>
                ))}
                {enc.prescriptions.length === 0 && <tr><td className="empty-state">No medications recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Vitals</h3>
            {!resolved && <VitalsForm onSubmit={(v) => addVitals(enc.id, v)} />}
            <table className="table" style={{ marginTop: 10 }}>
              <tbody>
                {enc.vitals.slice().reverse().map((v, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{new Date(v.takenAt).toLocaleTimeString('en-IN')}</td>
                    <td className="mono" style={{ fontSize: 12 }}>T {v.temp}°F · P {v.pulse} · BP {v.bp} · SpO2 {v.spo2}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Orders</h3>
            {!resolved && (
              <div className="row">
                <select value={orderType} onChange={(e) => setOrderType(e.target.value as 'lab' | 'radiology')} style={{ maxWidth: 130 }}>
                  <option value="lab">Lab</option>
                  <option value="radiology">Radiology</option>
                </select>
                <OrderTestInput kind={orderType} value={orderName} onChange={(text, id) => { setOrderName(text); setOrderTestId(id); }} placeholder="e.g. ECG, CT Head" />
                <button className="btn btn-sm" onClick={handleAddOrder}>Add</button>
              </div>
            )}
            <table className="table" style={{ marginTop: 10 }}>
              <tbody>
                {enc.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td><Badge tone="neutral">{o.type}</Badge></td>
                    <td><OrderProgress order={o} /></td>
                  </tr>
                ))}
                {enc.orders.length === 0 && <tr><td className="empty-state">No orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Disposition</h3>
        {resolved ? (
          <div>
            <p style={{ fontSize: 13 }}>
              {enc.status === 'admitted' && enc.linkedEncounterId && (
                <>Admitted to IPD — <Link to={`/ipd/patient/${enc.linkedEncounterId}`}>view IPD chart →</Link></>
              )}
              {enc.status === 'discharged' && 'Discharged from ER.'}
              {enc.status === 'referred' && `Referred to ${enc.referredTo ?? 'another facility'}.`}
              {enc.status === 'lama' && 'Patient left against medical advice.'}
              {enc.status === 'deceased' && 'Patient declared deceased in ER.'}
            </p>
            {enc.dispositionNote && <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Note: {enc.dispositionNote}</p>}
          </div>
        ) : (
          <>
            <div className="card-sub">How is this case being resolved?</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={() => setShowAdmit(true)}>Admit to IPD</button>
              <button className="btn btn-sm" onClick={() => setDispositionModal('discharged')}>Discharge</button>
              <button className="btn btn-sm" onClick={() => setDispositionModal('referred')}>Refer to Another Facility</button>
              <button className="btn btn-sm" onClick={() => setDispositionModal('lama')}>Left Against Medical Advice</button>
              <button className="btn btn-sm" onClick={() => setDispositionModal('deceased')}>Deceased</button>
            </div>
          </>
        )}
      </div>

      {showAdmit && (
        <AdmitToIpdModal
          patientId={patient.id}
          department="Emergency"
          onClose={() => setShowAdmit(false)}
          sourceEncounterId={enc.id}
        />
      )}

      {dispositionModal && (
        <DispositionModal
          disposition={dispositionModal}
          onClose={() => setDispositionModal(null)}
          onConfirm={async (note, referredTo) => {
            if ((await resolveErEncounter(enc.id, dispositionModal, note, referredTo)) === false) return;
            setDispositionModal(null);
            navigate(canOpen(currentRole, '/billing') ? '/billing' : '/emergency');
          }}
        />
      )}
    </>
  );
}

const DISPOSITION_TITLE: Record<ErDisposition, string> = {
  discharged: 'Discharge from ER',
  referred: 'Refer to Another Facility',
  lama: 'Left Against Medical Advice (LAMA)',
  deceased: 'Record Death in ER',
};

function DispositionModal({
  disposition,
  onClose,
  onConfirm,
}: {
  disposition: ErDisposition;
  onClose: () => void;
  onConfirm: (note: string, referredTo?: string) => void;
}) {
  const [note, setNote] = useState('');
  const [referredTo, setReferredTo] = useState('');
  const needsFacility = disposition === 'referred';
  const canConfirm = note.trim().length > 0 && (!needsFacility || referredTo.trim().length > 0);

  return (
    <Modal title={DISPOSITION_TITLE[disposition]} onClose={onClose} width={460}>
      {disposition === 'deceased' && (
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
          This records the outcome in the patient's record and generates final ER billing. Please confirm the details are accurate.
        </p>
      )}
      {needsFacility && (
        <div className="field">
          <label>Referred To (Facility Name)</label>
          <input value={referredTo} onChange={(e) => setReferredTo(e.target.value)} placeholder="e.g. City General Hospital" autoFocus />
        </div>
      )}
      <div className="field">
        <label>{disposition === 'deceased' ? 'Cause / Circumstances' : disposition === 'referred' ? 'Reason for Referral' : 'Notes'}</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Brief summary…" autoFocus={!needsFacility} />
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!canConfirm} onClick={() => onConfirm(note, needsFacility ? referredTo : undefined)}>
          Confirm
        </button>
      </div>
    </Modal>
  );
}

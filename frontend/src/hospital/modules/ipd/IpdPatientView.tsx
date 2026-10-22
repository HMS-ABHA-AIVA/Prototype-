import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { VitalsForm } from '../../components/shared/VitalsForm';
import { DrugNameInput } from '../../components/shared/DrugNameInput';
import { canOpen } from '../../components/layout/navConfig';
import { AISuggestion } from '../../components/ui/AISuggestion';
import { apiEnabled } from '../../api/client';
import * as ipdApi from '../../api/ipd';
import { reportError } from '../../store/useNoticeStore';
import { AdmissionFormPrint, BirthsPanel, DischargeSummaryPrint, DocumentsPanel } from './IpdRecords';
import { OrderTestInput } from '../../components/shared/OrderTestInput';
import { PatientMedicinePanel } from './WardMedicine';
import { OrderProgress } from '../lab/OrderProgress';

export function IpdPatientView() {
  const { encounterId } = useParams();
  const navigate = useNavigate();
  const {
    encounters,
    patients,
    beds,
    addVitals,
    addPrescription,
    addOrder,
    dispensePrescription,
    generateDischargeDraft,
    acceptDischargeSummary,
    generateBill,
    currentRole,
  } = useHospitalStore();
  useRefresh(['patients', 'encounters', 'beds', 'staff']);

  const [tab, setTab] = useState<'clinical' | 'nursing' | 'discharge' | 'records'>('clinical');
  const [form, setForm] = useState<{ kind: 'admission' | 'discharge'; running: ipdApi.RunningBill } | null>(null);
  const [drugName, setDrugName] = useState('');
  const [dose, setDose] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [noteText, setNoteText] = useState('');

  const encounter = encounters.find((e) => e.id === encounterId);
  const patient = patients.find((p) => p.id === encounter?.patientId);
  const bed = beds.find((b) => b.id === encounter?.bedId);

  if (!encounter || !patient) return <div className="empty-state">IPD encounter not found.</div>;

  const enc = encounter;

  /** Opens a printable form, filled in from the admission's own record. */
  async function openForm(kind: 'admission' | 'discharge') {
    try {
      setForm({ kind, running: await ipdApi.fetchRunningBill(enc.id) });
    } catch (err) {
      reportError(err);
    }
  }

  function handleGenerateDraft() {
    generateDischargeDraft(enc.id);
  }

  async function handleAcceptDischarge(finalText: string) {
    if ((await acceptDischargeSummary(enc.id, finalText)) === false) return;
    generateBill(enc.id);
    // The bill is made from the stay's charges: take whoever can open it straight there.
    if (apiEnabled && (canOpen(currentRole, '/ipd-billing') || currentRole === 'doctor')) navigate(`/ipd-billing/${enc.id}`);
    else navigate(canOpen(currentRole, '/billing') ? '/billing' : '/ipd');
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>{patient.name} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 16 }}>· {bed?.ward} {bed?.bedNo}</span></h1>
          <div className="sub">
            {patient.age}{patient.gender} · MRN {patient.mrn} · {encounter.department} · Admitted {encounter.admittedAt ? new Date(encounter.admittedAt).toLocaleDateString('en-IN') : '-'}
            {patient.allergies.length > 0 && <> · <Badge tone="danger">Allergy: {patient.allergies.join(', ')}</Badge></>}
          </div>
        </div>
        <div className="row">
          {apiEnabled && canOpen(currentRole, '/ipd-billing') && <Link to={`/ipd-billing/${encounter.id}`} className="btn btn-sm">Bill & advances</Link>}
          <Link to={`/emr/${patient.id}`} className="btn btn-sm">Full EMR Chart</Link>
        </div>
      </div>

      <div className="tabs">
        <div className={`tab${tab === 'clinical' ? ' active' : ''}`} onClick={() => setTab('clinical')}>Doctor Rounds</div>
        <div className={`tab${tab === 'nursing' ? ' active' : ''}`} onClick={() => setTab('nursing')}>Nursing Station</div>
        <div className={`tab${tab === 'discharge' ? ' active' : ''}`} onClick={() => setTab('discharge')}>Discharge</div>
        {apiEnabled && <div className={`tab${tab === 'records' ? ' active' : ''}`} onClick={() => setTab('records')}>Forms & documents</div>}
      </div>

      {form?.kind === 'admission' && <AdmissionFormPrint running={form.running} patient={patient} onClose={() => setForm(null)} />}
      {form?.kind === 'discharge' && <DischargeSummaryPrint running={form.running} patient={patient} encounter={encounter} onClose={() => setForm(null)} />}

      {tab === 'records' && apiEnabled && (
        <>
          <div className="card">
            <h3>Forms</h3>
            <div className="card-sub">Printed from this admission's record, so nothing is written twice</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => openForm('admission')}>🖨 Admission form &amp; consent</button>
              <button className="btn btn-sm" disabled={!encounter.dischargeSummary} title={encounter.dischargeSummary ? undefined : 'Available once the discharge summary is signed off'} onClick={() => openForm('discharge')}>🖨 Discharge summary</button>
            </div>
          </div>
          <DocumentsPanel encounterId={encounter.id} />
          {patient.gender === 'F' && <BirthsPanel encounterId={encounter.id} />}
        </>
      )}

      {tab === 'clinical' && (
        <div className="grid-2">
          <div className="card">
            <h3>Medications (MAR)</h3>
            <div className="card-sub">Medication administration record for this stay</div>
            <div className="two-col">
              <div className="field"><label>Drug Name</label><DrugNameInput value={drugName} onChange={setDrugName} encounterId={encounter.id} /></div>
              <div className="field"><label>Dose</label><input value={dose} onChange={(e) => setDose(e.target.value)} /></div>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => {
                if (!drugName || !dose) return;
                addPrescription(encounter.id, { drugName, dose, frequency: 'BD', duration: 'Ongoing' });
                setDrugName(''); setDose('');
              }}
            >
              + Add Medication
            </button>
            <table className="table" style={{ marginTop: 12 }}>
              <tbody>
                {encounter.prescriptions.map((rx) => (
                  <tr key={rx.id}>
                    <td style={{ fontWeight: 500 }}>{rx.drugName}</td>
                    <td>{rx.dose} · {rx.frequency}</td>
                    <td>{rx.dispensed ? <Badge tone="ok">{apiEnabled ? 'Dispensed' : 'Administered'}</Badge> : <Badge tone="neutral">{apiEnabled ? 'With pharmacy' : 'Pending'}</Badge>}</td>
                    <td>
                      {!rx.dispensed && !apiEnabled && (
                        <button className="btn btn-sm" onClick={() => dispensePrescription(encounter.id, rx.id)}>Mark Given</button>
                      )}
                    </td>
                  </tr>
                ))}
                {encounter.prescriptions.length === 0 && <tr><td className="empty-state">No medications recorded.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Orders</h3>
            <OrderQuickAdd onAdd={(type, name, investigationId) => addOrder(encounter.id, { type, name, investigationId })} />
            <table className="table" style={{ marginTop: 10 }}>
              <tbody>
                {encounter.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td><Badge tone="neutral">{o.type}</Badge></td>
                    <td><OrderProgress order={o} /></td>
                  </tr>
                ))}
                {encounter.orders.length === 0 && <tr><td className="empty-state">No orders yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'nursing' && apiEnabled && <PatientMedicinePanel encounterId={encounter.id} prescriptions={encounter.prescriptions} />}

      {tab === 'nursing' && (
        <div className="grid-2">
          <div className="card">
            <h3>Vitals Charting</h3>
            <VitalsForm onSubmit={(v) => addVitals(encounter.id, v)} />
            <table className="table" style={{ marginTop: 10 }}>
              <tbody>
                {encounter.vitals.slice().reverse().map((v, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{new Date(v.takenAt).toLocaleString('en-IN')}</td>
                    <td className="mono" style={{ fontSize: 12 }}>T {v.temp}°F · P {v.pulse} · BP {v.bp} · SpO2 {v.spo2}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Task / Handover List</h3>
            <div className="row">
              <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="e.g. Reposition patient at 2pm" />
              <button
                className="btn btn-sm"
                onClick={() => { if (noteText.trim()) { setNotes([noteText, ...notes]); setNoteText(''); } }}
              >
                Add
              </button>
            </div>
            <div className="stack" style={{ marginTop: 12 }}>
              {notes.map((n, i) => (
                <div key={i} className="row" style={{ fontSize: 13, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                  <input type="checkbox" style={{ width: 'auto' }} />
                  {n}
                </div>
              ))}
              {notes.length === 0 && <div className="empty-state">No pending tasks.</div>}
            </div>
          </div>
        </div>
      )}

      {tab === 'discharge' && (
        <div className="card">
          <h3>Discharge Summary</h3>
          <div className="card-sub">FHIR Bundle-ready structure · AI-assisted drafting with mandatory clinician sign-off</div>

          {encounter.dischargeSummary ? (
            <div className="empty-state">Discharged — summary signed off and sent to billing.</div>
          ) : encounter.aiDischargeSummaryDraft ? (
            <AISuggestion
              label="Draft discharge summary"
              draft={encounter.aiDischargeSummaryDraft}
              onAccept={handleAcceptDischarge}
              acceptLabel="Sign Off & Discharge"
            />
          ) : (
            <button className="btn btn-primary" onClick={handleGenerateDraft}>
              ✨ Generate AI Draft Discharge Summary
            </button>
          )}
        </div>
      )}
    </>
  );
}

function OrderQuickAdd({ onAdd }: { onAdd: (type: 'lab' | 'radiology', name: string, investigationId?: string) => void }) {
  const [type, setType] = useState<'lab' | 'radiology'>('lab');
  const [name, setName] = useState('');
  const [testId, setTestId] = useState<string | undefined>(undefined);
  return (
    <div className="row">
      <select value={type} onChange={(e) => setType(e.target.value as 'lab' | 'radiology')} style={{ maxWidth: 130 }}>
        <option value="lab">Lab</option>
        <option value="radiology">Radiology</option>
      </select>
      <OrderTestInput kind={type} value={name} onChange={(text, id) => { setName(text); setTestId(id); }} />
      <button className="btn btn-sm" onClick={() => { if (name) { onAdd(type, name, testId); setName(''); setTestId(undefined); } }}>Add</button>
    </div>
  );
}

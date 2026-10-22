import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { AdmitToIpdModal } from '../ipd/AdmitToIpdModal';
import { VitalsForm } from '../../components/shared/VitalsForm';
import { ConsultAssistant } from '../../components/ai/ConsultAssistant';
import { DrugNameInput } from '../../components/shared/DrugNameInput';
import { PrescriptionSheet } from '../../components/shared/PrescriptionSheet';
import { apiEnabled } from '../../api/client';
import { fetchTemplates, type RxTemplate } from '../../api/masters';
import { OrderTestInput } from '../../components/shared/OrderTestInput';
import { OrderProgress } from '../lab/OrderProgress';
import { TemplateDialog } from '../masters/MastersPage';

export function ConsultationView() {
  const { encounterId } = useParams();
  const navigate = useNavigate();
  const {
    encounters,
    patients,
    saveSoapNote,
    addVitals,
    addPrescription,
    addOrder,
    closeConsult,
    generateBill,
    staff,
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
  const [frequency, setFrequency] = useState('OD');
  const [duration, setDuration] = useState('5 days');

  const [orderType, setOrderType] = useState<'lab' | 'radiology'>('lab');
  const [orderName, setOrderName] = useState('');
  const [orderTestId, setOrderTestId] = useState<string | undefined>(undefined);
  const [templates, setTemplates] = useState<RxTemplate[]>([]);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);

  // Saved prescriptions (backend only). A template only fills in the lines: each one still goes through the usual allergy and duplicate checks.
  const loadTemplates = () => { if (apiEnabled) fetchTemplates().then(setTemplates, () => undefined); };
  useEffect(loadTemplates, []);

  const [showAdmit, setShowAdmit] = useState(false);
  const [showRx, setShowRx] = useState(false);

  // With a backend the visit may arrive after the page opens: fill the note boxes once it does.
  useEffect(() => {
    setSubjective(encounter?.soap?.subjective ?? '');
    setObjective(encounter?.soap?.objective ?? '');
    setAssessment(encounter?.soap?.assessment ?? '');
    setPlan(encounter?.soap?.plan ?? '');
    // only when a different visit is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter?.id]);

  if (!encounter || !patient) {
    return <div className="empty-state">Encounter not found.</div>;
  }

  const enc = encounter;

  // Dictated text is added after whatever is already in the box, never over it.
  const append = (current: string, added?: string) => (added ? (current.trim() ? `${current.trim()} ${added}` : added) : current);
  function fillNote(sections: { subjective?: string; objective?: string; assessment?: string; plan?: string }) {
    setSubjective((c) => append(c, sections.subjective));
    setObjective((c) => append(c, sections.objective));
    setAssessment((c) => append(c, sections.assessment));
    setPlan((c) => append(c, sections.plan));
  }

  function handleSaveSoap() {
    saveSoapNote(enc.id, { subjective, objective, assessment, plan });
  }

  function handleAddPrescription() {
    if (!drugName || !dose) return;
    addPrescription(enc.id, { drugName, dose, frequency, duration });
    setDrugName('');
    setDose('');
  }

  function handleAddOrder() {
    if (!orderName) return;
    addOrder(enc.id, { type: orderType, name: orderName, investigationId: orderTestId });
    setOrderName('');
    setOrderTestId(undefined);
  }

  function applyTemplate(id: string) {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    for (const item of template.items) addPrescription(enc.id, item);
    if (template.diagnosis && !assessment.trim()) setAssessment(template.diagnosis);
  }

  async function handleCloseAndBill() {
    // One after the other: the server refuses a note once the visit is closed.
    if ((await saveSoapNote(enc.id, { subjective, objective, assessment, plan })) === false) return;
    if ((await closeConsult(enc.id)) === false) return;
    generateBill(enc.id);
    // The consultation fee was collected at OPD billing before the patient joined the queue. Anything extra (tests, medicines)
    // appears as a bill in Billing; the doctor simply goes back to the queue.
    navigate('/opd');
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>{patient.name} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 16 }}>· Token #{encounter.tokenNo}</span></h1>
          <div className="sub">
            {patient.age}{patient.gender} · MRN {patient.mrn} · {encounter.department}
            {patient.allergies.length > 0 && <> · <Badge tone="danger">Allergy: {patient.allergies.join(', ')}</Badge></>}
          </div>
        </div>
        <div className="row">
          <Link to={`/emr/${patient.id}`} className="btn btn-sm">Full EMR Chart</Link>
          <button className="btn btn-sm" onClick={() => setShowAdmit(true)}>Admit to IPD</button>
          <button className="btn btn-primary btn-sm" onClick={handleCloseAndBill}>Close Consultation</button>
        </div>
      </div>

      <div className="grid-2">
        <div>
          {/* The AI assistant needs the backend; the stand-alone demo does not have it. */}
          {apiEnabled && (
            <ConsultAssistant
              encounterId={enc.id}
              note={{ subjective, objective, assessment, plan }}
              onFillNote={fillNote}
              onRecordVitals={(v) => addVitals(enc.id, v)}
              onAddOrder={(o) => addOrder(enc.id, o)}
              onAddPrescription={(rx) => addPrescription(enc.id, rx)}
            />
          )}

          <div className="card">
            <h3>Consultation Notes (SOAP)</h3>
            <div className="card-sub">Structured clinical documentation for this visit</div>
            <div className="field">
              <label>Subjective</label>
              <textarea rows={2} value={subjective} onChange={(e) => setSubjective(e.target.value)} placeholder="Patient's reported symptoms, history…" />
            </div>
            <div className="field">
              <label>Objective</label>
              <textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Exam findings, vitals…" />
            </div>
            <div className="field">
              <label>Assessment</label>
              <textarea rows={2} value={assessment} onChange={(e) => setAssessment(e.target.value)} placeholder="Diagnosis / differential…" />
            </div>
            <div className="field">
              <label>Plan</label>
              <textarea rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Treatment plan, follow-up…" />
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleSaveSoap}>Save Note</button>
          </div>

          <div className="card">
            <div className="flex-between">
              <div>
                <h3>e-Prescription</h3>
                <div className="card-sub">Add medications for this visit</div>
              </div>
              <div className="row">
                {apiEnabled && templates.length > 0 && (
                  <select value="" onChange={(e) => applyTemplate(e.target.value)} aria-label="Use a saved prescription" style={{ maxWidth: 190 }}>
                    <option value="">Use a template…</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.shared ? '' : ' (mine)'}</option>)}
                  </select>
                )}
                {apiEnabled && encounter.prescriptions.length > 0 && <button className="btn btn-sm" onClick={() => setShowSaveTemplate(true)}>Save as template</button>}
                <button className="btn btn-sm" onClick={() => setShowRx(true)}>View / Print Prescription</button>
              </div>
            </div>
            <div className="two-col">
              <div className="field">
                <label>Drug Name</label>
                <DrugNameInput value={drugName} onChange={setDrugName} placeholder="e.g. Amoxicillin 500mg" encounterId={enc.id} />
              </div>
              <div className="field">
                <label>Dose</label>
                <input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="e.g. 1 tab" />
              </div>
              <div className="field">
                <label>Frequency</label>
                <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                  <option>OD</option><option>BD</option><option>TDS</option><option>QID</option><option>SOS</option>
                </select>
              </div>
              <div className="field">
                <label>Duration</label>
                <input value={duration} onChange={(e) => setDuration(e.target.value)} />
              </div>
            </div>
            <button className="btn btn-sm" onClick={handleAddPrescription}>+ Add to Prescription</button>

            <table className="table" style={{ marginTop: 14 }}>
              <tbody>
                {encounter.prescriptions.map((rx) => (
                  <tr key={rx.id}>
                    <td style={{ fontWeight: 500 }}>{rx.drugName} {rx.aiSuggested && <Badge tone="info">AI-suggested</Badge>}</td>
                    <td>{rx.dose} · {rx.frequency} · {rx.duration}</td>
                    <td>{rx.dispensed ? <Badge tone="ok">Dispensed</Badge> : <Badge tone="neutral">Pending</Badge>}</td>
                  </tr>
                ))}
                {encounter.prescriptions.length === 0 && <tr><td className="empty-state">No medications added yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Vitals</h3>
            <VitalsForm onSubmit={(v) => addVitals(encounter.id, v)} />
            <table className="table" style={{ marginTop: 10 }}>
              <tbody>
                {encounter.vitals.slice().reverse().map((v, i) => (
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
            <div className="card-sub">Lab / radiology orders</div>
            <div className="row">
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as 'lab' | 'radiology')} style={{ maxWidth: 130 }}>
                <option value="lab">Lab</option>
                <option value="radiology">Radiology</option>
              </select>
              <OrderTestInput kind={orderType} value={orderName} onChange={(text, id) => { setOrderName(text); setOrderTestId(id); }} placeholder="e.g. CBC, Chest X-ray" />
              <button className="btn btn-sm" onClick={handleAddOrder}>Add</button>
            </div>
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
      </div>

      {showSaveTemplate && (
        <TemplateDialog
          template={null}
          initial={{ diagnosis: assessment.split('\n')[0]?.slice(0, 200), items: encounter.prescriptions.map((rx) => ({ drugName: rx.drugName, dose: rx.dose, frequency: rx.frequency, duration: rx.duration })) }}
          onClose={() => setShowSaveTemplate(false)}
          onSaved={() => { setShowSaveTemplate(false); loadTemplates(); }}
        />
      )}
      {showRx && <PrescriptionSheet encounter={encounter} patient={patient} doctor={staff.find((s) => s.id === encounter.doctorId)} onClose={() => setShowRx(false)} />}
      {showAdmit && <AdmitToIpdModal patientId={patient.id} department={encounter.department} onClose={() => setShowAdmit(false)} />}
    </>
  );
}

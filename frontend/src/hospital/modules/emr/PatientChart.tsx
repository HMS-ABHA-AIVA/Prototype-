import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPatient, fetchPatientEncounters } from '../../api/clinical';
import { canOpenPath } from '../../components/layout/navConfig';
import { useHospitalStore } from '../../store/useHospitalStore';
import { reportError } from '../../store/useNoticeStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { PrescriptionSheet } from '../../components/shared/PrescriptionSheet';
import type { Encounter, EncounterStatus, Patient } from '../../types';

const STATUS_TONE: Record<EncounterStatus, 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'black'> = {
  awaiting_payment: 'warn',
  cancelled: 'neutral',
  waiting: 'warn',
  in_consult: 'info',
  in_er: 'warn',
  admitted: 'info',
  discharged: 'ok',
  referred: 'info',
  lama: 'neutral',
  deceased: 'black',
  billed: 'ok',
  closed: 'ok',
};

export function PatientChart() {
  const { patientId } = useParams();
  const { staff, currentRole } = useHospitalStore();
  useRefresh(['staff']);
  const [patient, setPatient] = useState<Patient | null | undefined>(undefined);
  const [visits, setVisits] = useState<Encounter[]>([]);
  const [rxFor, setRxFor] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;
    let current = true;
    fetchPatient(patientId).then(
      (p) => { if (current) setPatient(p); },
      () => { if (current) setPatient(null); },
    );
    fetchPatientEncounters(patientId).then((rows) => { if (current) setVisits(rows); }, reportError);
    return () => { current = false; };
  }, [patientId]);

  const history = [...visits].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  if (patient === undefined) return <div className="empty-state">Loading…</div>;
  if (!patient) return <div className="empty-state">Patient not found.</div>;

  return (
    <>
      <div className="os-head">
        <div>
          <h1>{patient.name}</h1>
          <div className="sub">
            {patient.age}{patient.gender} · MRN <span className="mono">{patient.mrn}</span> · {patient.phone}
          </div>
        </div>
        <div className="row">
          {patient.abhaStatus === 'linked' ? (
            <Badge tone="ok">ABHA {patient.abhaAddress ?? patient.abhaNumber}</Badge>
          ) : (
            <Badge tone="neutral">ABHA not linked</Badge>
          )}
          {canOpenPath(currentRole, `/record/${patient.id}`) && (
            <Link to={`/record/${patient.id}`} className="btn btn-sm">Registration &amp; ABHA</Link>
          )}
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <h3>Problem List</h3>
          {patient.problemList.length === 0 ? (
            <div className="empty-state">No active problems documented.</div>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {patient.problemList.map((p) => <Badge key={p} tone="info">{p}</Badge>)}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Allergies</h3>
          {patient.allergies.length === 0 ? (
            <div className="empty-state">NKDA — no known drug allergies.</div>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {patient.allergies.map((a) => <Badge key={a} tone="danger">{a}</Badge>)}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Encounter History</h3>
        <div className="card-sub">All OPD/IPD/ER visits, structured close to FHIR R4 resources for future ABDM export</div>
        {history.map((e) => {
          const doctor = staff.find((s) => s.id === e.doctorId);
          return (
            <div key={e.id} className="card" style={{ boxShadow: 'none', background: 'var(--bg)' }}>
              <div className="flex-between">
                <div>
                  <b>{e.type}</b> · {e.department} · {doctor?.name}
                  {e.type === 'ER' && e.triageLevel && (
                    <> · <Badge tone={e.triageLevel === 'red' ? 'danger' : e.triageLevel === 'yellow' ? 'warn' : e.triageLevel === 'black' ? 'black' : 'ok'}>{e.triageLevel} triage</Badge></>
                  )}
                  <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{new Date(e.createdAt).toLocaleString('en-IN')}</div>
                  {e.chiefComplaint && <div style={{ fontSize: 12.5, marginTop: 3 }}>Chief complaint: {e.chiefComplaint}</div>}
                </div>
                <Badge tone={STATUS_TONE[e.status] ?? 'info'}>{e.status.replace('_', ' ')}</Badge>
              </div>

              {(e.status === 'referred' || e.status === 'lama' || e.status === 'deceased') && e.dispositionNote && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-soft)' }}>
                  {e.status === 'referred' && e.referredTo && <>Referred to <b>{e.referredTo}</b> — </>}
                  {e.dispositionNote}
                </div>
              )}

              {e.soap && (
                <div style={{ marginTop: 10, fontSize: 12.5 }}>
                  <div><b>A:</b> {e.soap.assessment || '—'}</div>
                  <div><b>P:</b> {e.soap.plan || '—'}</div>
                </div>
              )}

              {e.vitals.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12 }} className="mono">
                  Latest vitals: T {e.vitals[e.vitals.length - 1].temp}°F · BP {e.vitals[e.vitals.length - 1].bp} · SpO2 {e.vitals[e.vitals.length - 1].spo2}%
                </div>
              )}

              {e.prescriptions.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12.5 }}>
                  <b>Medications:</b> {e.prescriptions.map((p) => `${p.drugName} (${p.dose} ${p.frequency})`).join(', ')}
                  {' '}<button className="btn btn-sm" onClick={() => setRxFor(e.id)}>View / Print Prescription</button>
                </div>
              )}

              {e.dischargeSummary && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>Discharge Summary</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, fontFamily: 'IBM Plex Mono, monospace', marginTop: 6 }}>{e.dischargeSummary}</pre>
                </details>
              )}
            </div>
          );
        })}
        {history.length === 0 && <div className="empty-state">No encounters recorded yet.</div>}
      </div>
      {rxFor && history.find((e) => e.id === rxFor) && (
        <PrescriptionSheet
          encounter={history.find((e) => e.id === rxFor)!}
          patient={patient}
          doctor={staff.find((s) => s.id === history.find((e) => e.id === rxFor)!.doctorId)}
          onClose={() => setRxFor(null)}
        />
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { fetchFacility, type FacilityProfile } from '../../api/facility';
import type { Encounter, Patient, Staff } from '../../types';
import { Modal } from '../ui/Modal';

const FREQUENCY_WORDS: Record<string, string> = {
  OD: 'Once daily',
  BD: 'Twice daily',
  TDS: 'Three times daily',
  QID: 'Four times daily',
  SOS: 'Only when needed',
  STAT: 'Immediately, once',
};

interface Props {
  encounter: Encounter;
  patient: Patient;
  doctor?: Staff;
  onClose: () => void;
}

const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * The prescription as a patient would receive it: hospital heading, patient and doctor details, diagnosis, medicines in
 * plain words, advice and tests, and a line for the doctor's signature. "Print" prints only this sheet (see the
 * @media print rules in global.css); the browser's print dialog can also save it as a PDF.
 */
export function PrescriptionSheet({ encounter, patient, doctor, onClose }: Props) {
  const [facility, setFacility] = useState<FacilityProfile | null>(null);

  useEffect(() => {
    if (!apiEnabled) return;
    fetchFacility().then(setFacility).catch(() => setFacility(null)); // the heading falls back to a plain one
  }, []);

  const latestVitals = encounter.vitals[encounter.vitals.length - 1];
  const advice = encounter.soap?.plan?.trim();
  const diagnosis = encounter.soap?.assessment?.trim();
  const place = [facility?.address, facility?.district, facility?.state, facility?.pincode].filter(Boolean).join(', ');
  const contact = [facility?.phone && `Phone ${facility.phone}`, facility?.email].filter(Boolean).join(' · ');

  return (
    <Modal title="Prescription" onClose={onClose} width={760}>
      <div className="rx-actions">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>🖨 Print / Save as PDF</button>
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="rx-sheet" id="rx-sheet">
        <div className="rx-head">
          <div className="rx-hospital">{facility?.name || 'AIVA OSHealth'}</div>
          {place && <div className="rx-small">{place}</div>}
          {contact && <div className="rx-small">{contact}</div>}
        </div>

        <div className="rx-meta">
          <div>
            <div><b>{patient.name}</b></div>
            <div>{patient.age} yrs · {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}</div>
            <div className="rx-small">MRN {patient.mrn}{patient.abhaStatus === 'linked' && patient.abhaNumber ? ` · ABHA ${patient.abhaNumber}` : ''}</div>
          </div>
          <div className="rx-right">
            <div>Date: <b>{dateOf(encounter.createdAt)}</b></div>
            {encounter.tokenNo !== undefined && <div className="rx-small">OPD token #{encounter.tokenNo} · {encounter.department}</div>}
            <div className="rx-small">{doctor ? `${doctor.name}${doctor.hprId ? ` · HPR ${doctor.hprId}` : ''}` : encounter.department}</div>
          </div>
        </div>

        {patient.allergies.length > 0 && <div className="rx-allergy">Allergies: {patient.allergies.join(', ')}</div>}
        {diagnosis && <div className="rx-line"><b>Diagnosis:</b> {diagnosis}</div>}
        {latestVitals && (
          <div className="rx-line rx-small">
            Vitals: {[
              latestVitals.temp ? `Temp ${latestVitals.temp}°F` : '',
              latestVitals.pulse ? `Pulse ${latestVitals.pulse}/min` : '',
              latestVitals.bp ? `BP ${latestVitals.bp} mmHg` : '',
              latestVitals.spo2 ? `SpO₂ ${latestVitals.spo2}%` : '',
            ].filter(Boolean).join(' · ')}
          </div>
        )}

        <div className="rx-symbol">℞</div>
        {encounter.prescriptions.length === 0 ? (
          <div className="rx-small">No medicines have been prescribed for this visit.</div>
        ) : (
          <table className="rx-table">
            <thead>
              <tr><th>#</th><th>Medicine</th><th>Dose</th><th>How often</th><th>For</th></tr>
            </thead>
            <tbody>
              {encounter.prescriptions.map((rx, i) => (
                <tr key={rx.id}>
                  <td>{i + 1}</td>
                  <td><b>{rx.drugName}</b></td>
                  <td>{rx.dose}</td>
                  <td>{FREQUENCY_WORDS[rx.frequency] ?? rx.frequency}</td>
                  <td>{rx.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {encounter.orders.length > 0 && (
          <div className="rx-line"><b>Tests advised:</b> {encounter.orders.map((o) => o.name).join(', ')}</div>
        )}
        {advice && <div className="rx-line"><b>Advice:</b> {advice}</div>}

        <div className="rx-sign">
          <div className="rx-small">Prescribed medicines should be taken as directed. Return or call if symptoms worsen.</div>
          <div className="rx-sign-line">{doctor?.name ?? 'Doctor'}<br /><span className="rx-small">Signature</span></div>
        </div>
      </div>
    </Modal>
  );
}

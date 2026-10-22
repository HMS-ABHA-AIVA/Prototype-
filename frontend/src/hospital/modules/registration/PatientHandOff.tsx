import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Stethoscope } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { fetchPatient } from '../../api/clinical';
import { canOpenPath } from '../../components/layout/navConfig';
import { useHospitalStore } from '../../store/useHospitalStore';
import { reportError } from '../../store/useNoticeStore';
import type { Patient } from '../../types';
import { SendToOpdBillingModal } from './SendToOpdBillingModal';

/**
 * On a patient's registration and ABHA record (an M1 screen): the way into the hospital modules for that patient, their
 * clinical chart, and sending them to OPD billing for today's doctors. Each button shows only for the roles that use it.
 */
export function PatientHandOff({ patientId }: { patientId: string }) {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [busy, setBusy] = useState(false);
  if (session?.kind !== 'staff') return null;

  const chart = canOpenPath(session.role, `/emr/${patientId}`);
  const billing = canOpenPath(session.role, '/opd-billing');
  if (!chart && !billing) return null;

  async function sendToBilling() {
    setBusy(true);
    try {
      const store = useHospitalStore.getState();
      // The dialog needs the doctors, and the patient's open visits (a speciality already open cannot be chosen again).
      await Promise.all([store.loadStaff(), store.loadEncounters()]);
      setPatient(await fetchPatient(patientId));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {chart && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate(`/emr/${patientId}`)}>
          <Stethoscope size={14} aria-hidden />
          Clinical chart
        </button>
      )}
      {billing && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={sendToBilling} disabled={busy}>
          <CreditCard size={14} aria-hidden />
          {busy ? 'Opening…' : 'Send to OPD billing'}
        </button>
      )}
      {patient && (
        <div className="os-page">
          <SendToOpdBillingModal patient={patient} onClose={() => setPatient(null)} />
        </div>
      )}
    </>
  );
}

import { useNavigate } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';

/** When a patient is also seeing another doctor today, say so (and where they are), so each doctor knows the patient may be elsewhere. */
function OtherDoctors({ patientId, except }: { patientId: string; except: string }) {
  const { encounters, staff } = useHospitalStore();
  const others = encounters.filter((o) => o.patientId === patientId && o.type === 'OPD' && o.id !== except && ['awaiting_payment', 'waiting', 'in_consult'].includes(o.status));
  if (others.length === 0) return null;
  return (
    <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--ink-soft)' }}>
      Also: {others.map((o) => `${staff.find((s) => s.id === o.doctorId)?.name ?? o.department} (${o.status === 'in_consult' ? 'in consultation' : o.status === 'waiting' ? `#${o.tokenNo}` : 'awaiting payment'})`).join(', ')}
    </div>
  );
}

export function OpdQueue() {
  const { encounters, patients, staff, currentRole, startConsult } = useHospitalStore();
  useRefresh(['patients', 'encounters', 'staff'], 15);
  const navigate = useNavigate();

  const opd = encounters
    // Only patients whose consultation fee has been collected (they have a token); visits still at OPD billing are not here.
    .filter((e) => e.type === 'OPD' && (e.status === 'waiting' || e.status === 'in_consult'))
    .sort((a, b) => (a.tokenNo ?? 0) - (b.tokenNo ?? 0));

  function openConsult(encounterId: string) {
    startConsult(encounterId);
    navigate(`/opd/consult/${encounterId}`);
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>OPD Queue</h1>
          <div className="sub">Patients who have registered and paid at OPD billing, in token order</div>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Patient</th>
              <th>Department</th>
              <th>Doctor</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opd.map((e) => {
              const patient = patients.find((p) => p.id === e.patientId);
              const doctor = staff.find((s) => s.id === e.doctorId);
              return (
                <tr key={e.id} className="clickable" onClick={() => openConsult(e.id)}>
                  <td className="mono">#{e.tokenNo}</td>
                  <td style={{ fontWeight: 500 }}>
                    {patient?.name}
                    <OtherDoctors patientId={e.patientId} except={e.id} />
                  </td>
                  <td>{e.department}</td>
                  <td>{doctor?.name}</td>
                  <td>
                    {e.status === 'waiting' && <Badge tone="warn">Waiting</Badge>}
                    {e.status === 'in_consult' && <Badge tone="info">In Consult</Badge>}
                  </td>
                  <td>
                    <button className="btn btn-sm" disabled={currentRole !== 'doctor' && currentRole !== 'admin'} onClick={(ev) => { ev.stopPropagation(); openConsult(e.id); }}>
                      {e.status === 'in_consult' ? 'Resume' : 'Start Consult'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {opd.length === 0 && (
              <tr><td colSpan={6} className="empty-state">No patients waiting.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

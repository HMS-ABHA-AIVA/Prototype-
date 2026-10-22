import { STANDARD_OPD_FEE, type ConsultationRequest } from '../../api/opdBilling';
import { DEPARTMENTS } from '../../modules/registration/departments';
import { useHospitalStore } from '../../store/useHospitalStore';
import type { Staff } from '../../types';

export const feeOf = (doctor?: Staff) => doctor?.opdFee ?? doctor?.consultationFee ?? STANDARD_OPD_FEE;
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/**
 * Choose one or more doctors for a patient, one per speciality (department). Each doctor is a separate consultation with their own
 * fee, token and appointment slip. `blocked` lists departments that already have an open visit for this patient.
 */
export function ConsultationPicker({
  value, onChange, blocked = [],
}: {
  value: ConsultationRequest[];
  onChange: (next: ConsultationRequest[]) => void;
  blocked?: string[];
}) {
  const { staff } = useHospitalStore();
  const doctors = staff.filter((s) => s.role === 'doctor');
  // The usual departments plus any a doctor works in (e.g. Cardiology) so every doctor can be chosen.
  const departments = [...new Set([...DEPARTMENTS, ...doctors.map((d) => d.department)])];
  const doctorsOf = (department: string) => {
    const own = doctors.filter((d) => d.department === department);
    return own.length > 0 ? own : doctors;
  };
  const used = value.map((c) => c.department);
  const free = departments.filter((d) => !used.includes(d) && !blocked.includes(d));

  const total = value.reduce((sum, c) => sum + feeOf(doctors.find((d) => d.id === c.doctorId)), 0);

  const setRow = (i: number, change: Partial<ConsultationRequest>) => onChange(value.map((c, j) => (j === i ? { ...c, ...change } : c)));
  function changeDepartment(i: number, department: string) {
    setRow(i, { department, doctorId: doctorsOf(department)[0]?.id ?? '' });
  }
  function addRow() {
    const department = free[0];
    if (!department) return;
    onChange([...value, { department, doctorId: doctorsOf(department)[0]?.id ?? '' }]);
  }

  return (
    <div>
      {value.map((row, i) => {
        const options = doctorsOf(row.department);
        const doctor = doctors.find((d) => d.id === row.doctorId);
        return (
          <div key={i} className="consult-row">
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              {i === 0 && <label>Speciality / Department</label>}
              <select value={row.department} onChange={(e) => changeDepartment(i, e.target.value)}>
                {[row.department, ...free].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              {i === 0 && <label>Doctor</label>}
              <select value={row.doctorId} onChange={(e) => setRow(i, { doctorId: e.target.value })}>
                {options.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="consult-fee">
              {i === 0 && <label>Fee</label>}
              <div className="mono">{rupees(feeOf(doctor))}</div>
            </div>
            {value.length > 1 && (
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${row.department}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
            )}
          </div>
        );
      })}

      <div className="flex-between" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-sm" disabled={free.length === 0 || value.length >= 6} onClick={addRow}>+ Add another doctor</button>
        <div style={{ fontSize: 13 }}>
          {value.length} consultation{value.length === 1 ? '' : 's'} · <b className="mono">{rupees(total)}</b>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)', textAlign: 'right' }}>each gets its own slip and token</div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useHospitalStore } from '../../store/useHospitalStore';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import type { AttendanceStatus, EmploymentType, PayrollRun, Role, Shift, Staff } from '../../types';
import { currentMonth, todayLocal } from '../../utils/dates';

function formatMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const SHIFTS: { key: Shift; label: string }[] = [
  { key: 'morning', label: 'Morning' },
  { key: 'evening', label: 'Evening' },
  { key: 'night', label: 'Night' },
];
const SHIFT_LABEL: Record<Shift, string> = { morning: 'Morning', evening: 'Evening', night: 'Night' };

const ROLE_LABEL: Record<Role, string> = {
  front_office: 'Front Office',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacist: 'Pharmacist',
  biller: 'Biller',
  housekeeping: 'Housekeeping',
  lab: 'Lab & Radiology',
  admin: 'Administrator',
};

/** A deduction field that saves when you leave it, and goes back to the saved amount if the server refuses the change. */
function DeductionInput({ saved, onSave }: { saved: number; onSave: (value: number) => void | Promise<boolean> }) {
  const [draft, setDraft] = useState(String(saved));
  useEffect(() => setDraft(String(saved)), [saved]);
  return (
    <input
      type="number"
      value={draft}
      style={{ width: 90, textAlign: 'right' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={async () => {
        const value = Number(draft) || 0;
        if (value === saved) return setDraft(String(saved));
        if ((await onSave(value)) === false) setDraft(String(saved));
      }}
    />
  );
}

export function PayrollPage() {
  const { staff, payrollRuns, attendance, generatePayrollRun, finalizePayrollRun, markPayrollPaid, updatePayrollLineDeduction, loadStaff, loadPayrollRuns, loadAttendance } = useHospitalStore();
  const [tab, setTab] = useState<'staff' | 'attendance' | 'runs'>('runs');
  const [editStaff, setEditStaff] = useState<Staff | null>(null);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [attendanceDate, setAttendanceDate] = useState(todayLocal());
  const [attendanceShift, setAttendanceShift] = useState<Shift>('morning');
  const [activeRun, setActiveRun] = useState<PayrollRun | null>(null);
  const [genMonth, setGenMonth] = useState(currentMonth());

  const salariedStaff = staff.filter((s) => s.employmentType === 'salaried');
  const visitingStaff = staff.filter((s) => s.employmentType === 'visiting_fee');

  // With a backend, bring in the saved staff, payroll runs and the month being marked.
  useEffect(() => { void loadStaff(); void loadPayrollRuns(); }, [loadStaff, loadPayrollRuns]);
  useEffect(() => { void loadAttendance(attendanceDate.slice(0, 7)); }, [loadAttendance, attendanceDate]);

  async function handleGenerate() {
    const run = await generatePayrollRun(genMonth);
    if (run) {
      setActiveRun(run);
      setTab('runs');
    }
  }

  const sortedRuns = [...payrollRuns].sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  const displayedRun = activeRun ? payrollRuns.find((r) => r.id === activeRun.id) ?? null : null;

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Payroll & HR</h1>
          <div className="sub">Staff pay setup, attendance, and monthly payroll runs — visiting-doctor fees computed from OPD activity</div>
        </div>
      </div>

      <div className="tabs">
        <div className={`tab${tab === 'runs' ? ' active' : ''}`} onClick={() => setTab('runs')}>Payroll Runs</div>
        <div className={`tab${tab === 'attendance' ? ' active' : ''}`} onClick={() => setTab('attendance')}>Attendance</div>
        <div className={`tab${tab === 'staff' ? ' active' : ''}`} onClick={() => setTab('staff')}>Staff & Pay Setup</div>
      </div>

      {tab === 'runs' && !displayedRun && (
        <>
          <div className="card">
            <h3>Generate Payroll</h3>
            <div className="card-sub">Salaried staff prorated by attendance (26-day month); visiting doctors paid per completed OPD consult</div>
            <div className="row">
              <input type="month" value={genMonth} onChange={(e) => setGenMonth(e.target.value)} style={{ maxWidth: 180 }} />
              <button className="btn btn-primary" onClick={handleGenerate}>Generate Payroll Run</button>
            </div>
          </div>

          <div className="card">
            <h3>Past Runs</h3>
            <table className="table">
              <thead><tr><th>Month</th><th>Generated</th><th className="num">Staff</th><th className="num">Total Net Pay</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {sortedRuns.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setActiveRun(r)}>
                    <td style={{ fontWeight: 500 }}>{formatMonth(r.month)}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{new Date(r.generatedAt).toLocaleString('en-IN')} · {r.generatedBy}</td>
                    <td className="num mono">{r.lines.length}</td>
                    <td className="num mono">₹{r.lines.reduce((sum, l) => sum + l.netPay, 0).toLocaleString('en-IN')}</td>
                    <td>
                      {r.status === 'draft' && <Badge tone="warn">Draft</Badge>}
                      {r.status === 'finalized' && <Badge tone="info">Finalized</Badge>}
                      {r.status === 'paid' && <Badge tone="ok">Paid</Badge>}
                    </td>
                    <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setActiveRun(r); }}>View</button></td>
                  </tr>
                ))}
                {sortedRuns.length === 0 && <tr><td colSpan={6} className="empty-state">No payroll runs generated yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'runs' && displayedRun && (
        <div className="card">
          <div className="flex-between">
            <div>
              <h3>Payroll — {formatMonth(displayedRun.month)}</h3>
              <div className="card-sub">
                Generated {new Date(displayedRun.generatedAt).toLocaleString('en-IN')} by {displayedRun.generatedBy}
              </div>
            </div>
            <button className="btn btn-sm" onClick={() => setActiveRun(null)}>← All Runs</button>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Staff</th><th>Role</th><th>Basis</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net Pay</th>
              </tr>
            </thead>
            <tbody>
              {displayedRun.lines.map((l) => (
                <tr key={l.staffId}>
                  <td style={{ fontWeight: 500 }}>{l.staffName}</td>
                  <td>{ROLE_LABEL[l.role]}</td>
                  <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                    {l.employmentType === 'visiting_fee' ? (
                      `${l.consultCount} consult(s)`
                    ) : (
                      <>
                        {l.daysPresent}/{l.workingDays} shift-days
                        {l.doubleShiftDays > 0 && (
                          <>
                            {' '}<Badge tone="brand">{l.doubleShiftDays} double-shift day{l.doubleShiftDays > 1 ? 's' : ''}</Badge>
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td className="num mono">₹{l.grossPay.toLocaleString('en-IN')}</td>
                  <td className="num">
                    {displayedRun.status === 'draft' ? (
                      <DeductionInput
                        saved={l.deductions}
                        onSave={(value) => updatePayrollLineDeduction(displayedRun.id, l.staffId, value)}
                      />
                    ) : (
                      <span className="mono">₹{l.deductions.toLocaleString('en-IN')}</span>
                    )}
                  </td>
                  <td className="num mono" style={{ fontWeight: 600 }}>₹{l.netPay.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex-between" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <span style={{ fontWeight: 600 }}>
              Total: <span className="mono">₹{displayedRun.lines.reduce((sum, l) => sum + l.netPay, 0).toLocaleString('en-IN')}</span>
            </span>
            <div className="row">
              <button className="btn btn-sm">Export GL Summary (Tally) →</button>
              {displayedRun.status === 'draft' && (
                <button className="btn btn-primary" onClick={() => finalizePayrollRun(displayedRun.id)}>Finalize Payroll</button>
              )}
              {displayedRun.status === 'finalized' && (
                <button className="btn btn-primary" onClick={() => markPayrollPaid(displayedRun.id)}>Mark as Paid</button>
              )}
              {displayedRun.status === 'paid' && <Badge tone="ok">Paid — cycle complete</Badge>}
            </div>
          </div>
          <p className="sample-note">
            Each shift present/half-day adds shift-day credit, so a date with more than one shift marked (a double shift) pays out more than a regular day —
            visible above as "double-shift day(s)". Payroll here covers pay computation only; statutory deductions (PF/ESI/TDS) and GL posting are out of
            scope — export the summary above to your accounting system (e.g., Tally) for that.
          </p>
        </div>
      )}

      {tab === 'attendance' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>Date</label>
            <input type="date" value={attendanceDate} onChange={(e) => setAttendanceDate(e.target.value)} style={{ maxWidth: 180 }} />
            <label style={{ margin: '0 0 0 10px' }}>Marking Shift</label>
            <select value={attendanceShift} onChange={(e) => setAttendanceShift(e.target.value as Shift)} style={{ maxWidth: 150 }}>
              {SHIFTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 14 }}>
            A staff member can be marked present for more than one shift on the same date — a double (or triple) shift day counts as extra shift-days toward payroll.
          </p>
          <table className="table">
            <thead><tr><th>Staff</th><th>Department</th><th>Today's Shifts</th><th>Mark {SHIFT_LABEL[attendanceShift]}</th></tr></thead>
            <tbody>
              {salariedStaff.map((member) => {
                const dayEntries = attendance.filter((a) => a.staffId === member.id && a.date === attendanceDate);
                const currentShiftEntry = dayEntries.find((a) => a.shift === attendanceShift);
                return (
                  <AttendanceRow
                    key={member.id}
                    staff={member}
                    date={attendanceDate}
                    shift={attendanceShift}
                    currentStatus={currentShiftEntry?.status}
                    dayEntries={dayEntries}
                  />
                );
              })}
            </tbody>
          </table>
          <p className="sample-note">Visiting-fee doctors ({visitingStaff.map((v) => v.name).join(', ')}) are paid per consult and don't need daily attendance.</p>
        </div>
      )}

      {tab === 'staff' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Staff & Pay Setup</h3>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddStaff(true)}>+ Add Staff</button>
          </div>
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Department</th><th>Employment</th><th className="num">Rate</th><th>Bank A/C</th><th>Joined</th><th></th></tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id}>
                  <td style={{ fontWeight: 500 }}>{member.name}</td>
                  <td>{ROLE_LABEL[member.role]}</td>
                  <td style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{member.department}</td>
                  <td><Badge tone={member.employmentType === 'salaried' ? 'info' : 'brand'}>{member.employmentType === 'salaried' ? 'Salaried' : 'Visiting Fee'}</Badge></td>
                  <td className="num mono">
                    {member.employmentType === 'salaried' ? `₹${(member.monthlySalary ?? 0).toLocaleString('en-IN')}/mo` : `₹${member.feePerConsult ?? 0}/consult`}
                  </td>
                  <td className="mono">•••• {member.bankAccountLast4 ?? '----'}</td>
                  <td style={{ fontSize: 12 }}>{new Date(member.dateOfJoining).toLocaleDateString('en-IN')}</td>
                  <td><button className="btn btn-sm" onClick={() => setEditStaff(member)}>Edit Pay</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editStaff && <EditPayModal staff={editStaff} onClose={() => setEditStaff(null)} />}
      {showAddStaff && <AddStaffModal onClose={() => setShowAddStaff(false)} />}
    </>
  );
}

function AttendanceRow({
  staff,
  date,
  shift,
  currentStatus,
  dayEntries,
}: {
  staff: Staff;
  date: string;
  shift: Shift;
  currentStatus?: AttendanceStatus;
  dayEntries: { shift: Shift; status: AttendanceStatus }[];
}) {
  const { markAttendance } = useHospitalStore();
  const options: { key: AttendanceStatus; label: string; tone: 'ok' | 'danger' | 'warn' | 'neutral' }[] = [
    { key: 'present', label: 'Present', tone: 'ok' },
    { key: 'half_day', label: 'Half Day', tone: 'warn' },
    { key: 'leave', label: 'Leave', tone: 'neutral' },
    { key: 'absent', label: 'Absent', tone: 'danger' },
  ];
  const presentShiftCount = dayEntries.filter((e) => e.status === 'present' || e.status === 'half_day').length;
  const isDoubleShift = presentShiftCount > 1;

  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{staff.name}</td>
      <td style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{staff.department}</td>
      <td>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {dayEntries.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>No shifts marked</span>}
          {dayEntries.map((e) => (
            <Badge key={e.shift} tone={e.status === 'present' ? 'ok' : e.status === 'half_day' ? 'warn' : e.status === 'leave' ? 'neutral' : 'danger'}>
              {SHIFT_LABEL[e.shift]}: {e.status.replace('_', ' ')}
            </Badge>
          ))}
          {isDoubleShift && <Badge tone="brand">Double shift</Badge>}
        </div>
      </td>
      <td>
        <div className="row">
          {options.map((opt) => (
            <button
              key={opt.key}
              className={`btn btn-sm${currentStatus === opt.key ? ' btn-primary' : ''}`}
              onClick={() => markAttendance(staff.id, date, shift, opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function EditPayModal({ staff, onClose }: { staff: Staff; onClose: () => void }) {
  const { updatePayInfo } = useHospitalStore();
  const [employmentType, setEmploymentType] = useState<EmploymentType>(staff.employmentType);
  const [monthlySalary, setMonthlySalary] = useState(String(staff.monthlySalary ?? ''));
  const [feePerConsult, setFeePerConsult] = useState(String(staff.feePerConsult ?? ''));
  const [consultationFee, setConsultationFee] = useState(staff.consultationFee != null ? String(staff.consultationFee) : '');
  const [bankAccountLast4, setBankAccountLast4] = useState(staff.bankAccountLast4 ?? '');

  return (
    <Modal title={`Edit Pay Setup — ${staff.name}`} onClose={onClose} width={440}>
      <div className="field">
        <label>Employment Type</label>
        <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}>
          <option value="salaried">Salaried</option>
          <option value="visiting_fee">Visiting Fee (per consult)</option>
        </select>
      </div>
      {employmentType === 'salaried' ? (
        <div className="field">
          <label>Monthly Salary (₹)</label>
          <input type="number" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} />
        </div>
      ) : (
        <div className="field">
          <label>Fee Per Consult (₹)</label>
          <input type="number" value={feePerConsult} onChange={(e) => setFeePerConsult(e.target.value)} />
        </div>
      )}
      {staff.role === 'doctor' && (
        <div className="field">
          <label>Patient consultation fee (₹)</label>
          <input type="number" min={0} value={consultationFee} onChange={(e) => setConsultationFee(e.target.value)} placeholder="Standard OPD fee (₹600)" />
          <div className="ai-hint">What a patient pays at OPD billing to see this doctor. Different from the pay above, which is what the hospital pays the doctor. Leave empty for the standard fee.</div>
        </div>
      )}
      <div className="field">
        <label>Bank Account (last 4 digits)</label>
        <input value={bankAccountLast4} onChange={(e) => setBankAccountLast4(e.target.value)} maxLength={4} />
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={() => {
            updatePayInfo(staff.id, {
              employmentType,
              monthlySalary: employmentType === 'salaried' ? Number(monthlySalary) || 0 : undefined,
              feePerConsult: employmentType === 'visiting_fee' ? Number(feePerConsult) || 0 : undefined,
              ...(staff.role === 'doctor' ? { consultationFee: consultationFee.trim() === '' ? undefined : Number(consultationFee) } : {}),
              bankAccountLast4,
            });
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

function AddStaffModal({ onClose }: { onClose: () => void }) {
  const { addStaff } = useHospitalStore();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('nurse');
  const [department, setDepartment] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('salaried');
  const [monthlySalary, setMonthlySalary] = useState('20000');
  const [feePerConsult, setFeePerConsult] = useState('400');

  const invalid = !name.trim() || !department.trim();

  return (
    <Modal title="Add Staff Member" onClose={onClose} width={460}>
      <div className="field">
        <label>Full Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anjali Verma" autoFocus />
      </div>
      <div className="two-col">
        <div className="field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {Object.entries(ROLE_LABEL).map(([r, label]) => <option key={r} value={r}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Department</label>
          <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Ward B" />
        </div>
      </div>
      <div className="field">
        <label>Employment Type</label>
        <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}>
          <option value="salaried">Salaried</option>
          <option value="visiting_fee">Visiting Fee (per consult)</option>
        </select>
      </div>
      {employmentType === 'salaried' ? (
        <div className="field">
          <label>Monthly Salary (₹)</label>
          <input type="number" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} />
        </div>
      ) : (
        <div className="field">
          <label>Fee Per Consult (₹)</label>
          <input type="number" value={feePerConsult} onChange={(e) => setFeePerConsult(e.target.value)} />
        </div>
      )}
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={invalid}
          onClick={() => {
            addStaff({
              name,
              role,
              department,
              employmentType,
              monthlySalary: employmentType === 'salaried' ? Number(monthlySalary) || 0 : undefined,
              feePerConsult: employmentType === 'visiting_fee' ? Number(feePerConsult) || 0 : undefined,
              dateOfJoining: todayLocal(),
            });
            onClose();
          }}
        >
          Add Staff
        </button>
      </div>
    </Modal>
  );
}

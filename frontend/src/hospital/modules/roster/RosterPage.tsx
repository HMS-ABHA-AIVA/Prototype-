import { useEffect, useMemo, useState } from 'react';
import { useHospitalStore } from '../../store/useHospitalStore';
import { Badge } from '../../components/ui/Badge';
import type { Shift } from '../../types';
import { todayLocal } from '../../utils/dates';

const SHIFTS: { key: Shift; label: string; letter: string }[] = [
  { key: 'morning', label: 'Morning', letter: 'M' },
  { key: 'evening', label: 'Evening', letter: 'E' },
  { key: 'night', label: 'Night', letter: 'N' },
];

const TODAY = todayLocal();

// Local date components only — never toISOString() here, which converts to UTC
// and silently rolls the date back a day (or more, compounding across calls)
// in any timezone ahead of UTC.
function toISO(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function weekStart(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISO(d);
}

function formatDay(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function RosterPage() {
  const { staff, roster, attendance, attendanceAvailable, toggleRosterAssignment, copyWeek, loadStaff, loadRoster, loadAttendance } = useHospitalStore();
  const [anchor, setAnchor] = useState(weekStart(TODAY));
  const [deptFilter, setDeptFilter] = useState('all');
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);

  // With a backend, bring in the staff list and the visible week (and attendance for the months it touches).
  useEffect(() => { void loadStaff(); }, [loadStaff]);
  useEffect(() => {
    const first = weekDates[0];
    const last = weekDates[6];
    void loadRoster(first, last);
    void loadAttendance(first.slice(0, 7));
    if (last.slice(0, 7) !== first.slice(0, 7)) void loadAttendance(last.slice(0, 7));
  }, [weekDates, loadRoster, loadAttendance]);
  const departments = Array.from(new Set(staff.map((s) => s.department)));
  const rosterableStaff = staff.filter((s) => deptFilter === 'all' || s.department === deptFilter);

  function isAssigned(staffId: string, date: string, shift: Shift) {
    return roster.some((r) => r.staffId === staffId && r.date === date && r.shift === shift);
  }

  function coverageCount(date: string, shift: Shift) {
    return roster.filter((r) => r.date === date && r.shift === shift).length;
  }

  // Cross-check roster vs actual attendance for dates up to today.
  const exceptions = useMemo(() => {
    // Only administrators can read attendance; for other roles the cross-check would wrongly show everyone as absent.
    if (!attendanceAvailable) return [];
    const list: { staffName: string; date: string; shift: Shift; type: 'no_show' | 'unscheduled' }[] = [];
    const pastDates = weekDates.filter((d) => d <= TODAY);
    for (const date of pastDates) {
      for (const shift of SHIFTS) {
        const rostered = roster.filter((r) => r.date === date && r.shift === shift.key);
        for (const r of rostered) {
          const att = attendance.find((a) => a.staffId === r.staffId && a.date === date && a.shift === shift.key);
          if (!att || att.status === 'absent' || att.status === 'leave') {
            const member = staff.find((s) => s.id === r.staffId);
            list.push({ staffName: member?.name ?? r.staffId, date, shift: shift.key, type: 'no_show' });
          }
        }
        const worked = attendance.filter(
          (a) => a.date === date && a.shift === shift.key && (a.status === 'present' || a.status === 'half_day')
        );
        for (const a of worked) {
          const wasRostered = rostered.some((r) => r.staffId === a.staffId);
          if (!wasRostered) {
            const member = staff.find((s) => s.id === a.staffId);
            list.push({ staffName: member?.name ?? a.staffId, date, shift: shift.key, type: 'unscheduled' });
          }
        }
      }
    }
    return list;
  }, [weekDates, roster, attendance, staff, attendanceAvailable]);

  async function handleCopyLastWeek() {
    const prevStart = addDays(anchor, -7);
    const count = await copyWeek(prevStart, anchor);
    setCopyMsg(count > 0 ? `Copied ${count} shift(s) from last week.` : 'Nothing new to copy — last week had no shifts, or this week already has them.');
    setTimeout(() => setCopyMsg(null), 4000);
  }

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Staff Roster</h1>
          <div className="sub">Weekly duty schedule by shift — click a cell to assign or unassign a staff member</div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div className="row">
            <button className="btn btn-sm" onClick={() => setAnchor(addDays(anchor, -7))}>← Prev Week</button>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>
              {formatDay(weekDates[0])} – {formatDay(weekDates[6])}
            </span>
            <button className="btn btn-sm" onClick={() => setAnchor(addDays(anchor, 7))}>Next Week →</button>
            <button className="btn btn-sm" onClick={() => setAnchor(weekStart(TODAY))}>This Week</button>
          </div>
          <div className="row">
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ maxWidth: 200 }}>
              <option value="all">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="btn btn-sm" onClick={handleCopyLastWeek}>Copy Last Week →</button>
          </div>
        </div>
        {copyMsg && <p className="sample-note" style={{ marginTop: 8 }}>{copyMsg}</p>}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Staff</th>
              {weekDates.map((d) => (
                <th key={d} style={{ textAlign: 'center', background: d === TODAY ? 'var(--brand-soft)' : undefined }}>
                  {formatDay(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rosterableStaff.map((member) => (
              <tr key={member.id}>
                <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {member.name}
                  <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 400 }}>{member.department}</div>
                </td>
                {weekDates.map((date) => (
                  <td key={date} style={{ textAlign: 'center', background: date === TODAY ? '#FAFDFC' : undefined }}>
                    <div className="row" style={{ justifyContent: 'center', gap: 3 }}>
                      {SHIFTS.map((s) => {
                        const on = isAssigned(member.id, date, s.key);
                        return (
                          <button
                            key={s.key}
                            title={`${s.label}${on ? ' — assigned (click to remove)' : ' — click to assign'}`}
                            onClick={() => toggleRosterAssignment(member.id, date, s.key, member.department)}
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: 5,
                              fontSize: 10.5,
                              fontWeight: 700,
                              border: `1px solid ${on ? 'var(--brand)' : 'var(--border)'}`,
                              background: on ? 'var(--brand)' : 'var(--surface)',
                              color: on ? '#fff' : 'var(--ink-soft)',
                              cursor: 'pointer',
                            }}
                          >
                            {s.letter}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
            {rosterableStaff.length === 0 && (
              <tr><td colSpan={8} className="empty-state">No staff in this department.</td></tr>
            )}
          </tbody>
        </table>
        <p className="sample-note">M / E / N = Morning / Evening / Night. A staff member can be assigned more than one shift on the same date (a planned double shift).</p>
      </div>

      <div className="card">
        <h3>Shift Coverage</h3>
        <div className="card-sub">Staff assigned per shift, this week — 0 means an uncovered shift</div>
        <table className="table">
          <thead>
            <tr>
              <th>Shift</th>
              {weekDates.map((d) => <th key={d} className="num">{formatDay(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {SHIFTS.map((s) => (
              <tr key={s.key}>
                <td style={{ fontWeight: 500 }}>{s.label}</td>
                {weekDates.map((date) => {
                  const count = coverageCount(date, s.key);
                  return (
                    <td key={date} className="num">
                      {count === 0 ? <Badge tone="danger">0</Badge> : <span className="mono">{count}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Roster vs Attendance Exceptions</h3>
        <div className="card-sub">For dates up to today — rostered staff with no matching attendance ("no-show"), or attendance with no roster entry ("unscheduled")</div>
        {exceptions.length === 0 ? (
          <div className="empty-state">No exceptions — attendance matches the roster for this week so far.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Staff</th><th>Date</th><th>Shift</th><th>Issue</th></tr></thead>
            <tbody>
              {exceptions.map((e, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 500 }}>{e.staffName}</td>
                  <td>{formatDay(e.date)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{e.shift}</td>
                  <td>
                    {e.type === 'no_show' ? (
                      <Badge tone="danger">Rostered, no attendance</Badge>
                    ) : (
                      <Badge tone="warn">Worked, not rostered</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

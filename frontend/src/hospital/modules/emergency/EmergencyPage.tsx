import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { NewErCaseModal } from './NewErCaseModal';
import type { TriageLevel } from '../../types';
import { isToday } from '../../utils/dates';

const TRIAGE_ORDER: Record<TriageLevel, number> = { red: 0, yellow: 1, green: 2, black: 3 };
const TRIAGE_LABEL: Record<TriageLevel, string> = { red: 'Red — Immediate', yellow: 'Yellow — Urgent', green: 'Green — Non-urgent', black: 'Black — Deceased/Expectant' };

function timeSince(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function EmergencyPage() {
  const { encounters, patients, staff } = useHospitalStore();
  useRefresh(['patients', 'encounters', 'staff'], 15);
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);

  const active = encounters
    .filter((e) => e.type === 'ER' && e.status === 'in_er')
    .sort((a, b) => {
      const t = (TRIAGE_ORDER[a.triageLevel ?? 'green'] ?? 9) - (TRIAGE_ORDER[b.triageLevel ?? 'green'] ?? 9);
      return t !== 0 ? t : (a.createdAt < b.createdAt ? -1 : 1);
    });

  const resolvedToday = encounters.filter(
    (e) => e.type === 'ER' && e.status !== 'in_er' && isToday(e.createdAt)
  );

  const redCount = active.filter((e) => e.triageLevel === 'red').length;

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Emergency / Urgent Care</h1>
          <div className="sub">Live ER board — sorted by triage priority</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New ER Case</button>
      </div>

      <div className="kpi-row">
        <div className="kpi" style={{ borderBottomColor: redCount > 0 ? 'var(--danger)' : 'var(--brand)' }}>
          <div className="label">In ER Now</div>
          <div className="value">{active.length}</div>
        </div>
        <div className="kpi" style={{ borderBottomColor: 'var(--danger)' }}>
          <div className="label">Red (Immediate)</div>
          <div className="value">{redCount}</div>
        </div>
        <div className="kpi"><div className="label">Resolved Today</div><div className="value">{resolvedToday.length}</div></div>
      </div>

      <div className="status-legend" style={{ marginBottom: 16 }}>
        <span className="item"><span className="triage-swatch red" /> Red — Immediate</span>
        <span className="item"><span className="triage-swatch yellow" /> Yellow — Urgent</span>
        <span className="item"><span className="triage-swatch green" /> Green — Non-urgent</span>
        <span className="item"><span className="triage-swatch black" /> Black — Deceased/Expectant</span>
      </div>

      {active.length === 0 && <div className="empty-state">No active ER cases right now.</div>}
      {active.map((e) => {
        const patient = patients.find((p) => p.id === e.patientId);
        const doctor = staff.find((s) => s.id === e.doctorId);
        return (
          <div key={e.id} className={`er-card ${e.triageLevel ?? ''}`} onClick={() => navigate(`/emergency/case/${e.id}`)} style={{ cursor: 'pointer' }}>
            <div className="flex-between">
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {patient?.name} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 12 }}>· {patient?.age}{patient?.gender} · MRN {patient?.mrn}</span>
                </div>
                <div style={{ fontSize: 12.5, marginTop: 3 }}>{e.chiefComplaint}</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 4 }}>
                  {doctor?.name} · {e.arrivalMode === 'ambulance' ? 'By ambulance' : e.arrivalMode === 'referred_in' ? 'Referred in' : 'Walk-in'} · in ER {timeSince(e.createdAt)}
                </div>
              </div>
              <div className="row">
                <Badge tone={e.triageLevel === 'red' ? 'danger' : e.triageLevel === 'yellow' ? 'warn' : e.triageLevel === 'black' ? 'black' : 'ok'}>
                  {TRIAGE_LABEL[e.triageLevel ?? 'green']}
                </Badge>
                <button className="btn btn-sm" onClick={(ev) => { ev.stopPropagation(); navigate(`/emergency/case/${e.id}`); }}>Open Case</button>
              </div>
            </div>
          </div>
        );
      })}

      {showNew && <NewErCaseModal onClose={() => setShowNew(false)} />}
    </>
  );
}

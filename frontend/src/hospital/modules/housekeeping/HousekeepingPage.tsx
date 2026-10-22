import { Link } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';

function timeSince(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function HousekeepingPage() {
  const { beds, patients, housekeepingLog, startCleaning, completeCleaning } = useHospitalStore();
  useRefresh(['beds', 'patients', 'housekeepingLog'], 20);

  const dirty = beds.filter((b) => b.status === 'dirty').sort((a, b) => (a.statusSince < b.statusSince ? -1 : 1));
  const inProgress = beds.filter((b) => b.status === 'cleaning').sort((a, b) => (a.statusSince < b.statusSince ? -1 : 1));
  const occupied = beds.filter((b) => b.status === 'occupied').length;
  const vacant = beds.filter((b) => b.status === 'vacant').length;
  const wards = Array.from(new Set(beds.map((b) => b.ward)));

  const recentReleases = housekeepingLog.filter((l) => l.action === 'discharge_release').slice(0, 8);

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Housekeeping</h1>
          <div className="sub">Bed turnover board — discharge release, cleaning, and readiness, color-coded by status</div>
        </div>
        <Link to="/housekeeping/waste" className="btn btn-sm">Waste Management →</Link>
      </div>

      <div className="kpi-row">
        <div className="kpi" style={{ borderBottomColor: 'var(--danger)' }}>
          <div className="label">Awaiting Cleaning</div>
          <div className="value">{dirty.length}</div>
          <div className="sub">released beds, not yet started</div>
        </div>
        <div className="kpi" style={{ borderBottomColor: 'var(--warn)' }}>
          <div className="label">Cleaning In Progress</div>
          <div className="value">{inProgress.length}</div>
        </div>
        <div className="kpi" style={{ borderBottomColor: 'var(--success)' }}>
          <div className="label">Vacant & Ready</div>
          <div className="value">{vacant}</div>
        </div>
        <div className="kpi" style={{ borderBottomColor: 'var(--info)' }}>
          <div className="label">Occupied</div>
          <div className="value">{occupied}</div>
        </div>
      </div>

      <div className="status-legend" style={{ marginBottom: 16 }}>
        <span className="item"><span className="swatch occupied" /> Occupied</span>
        <span className="item"><span className="swatch dirty" /> Dirty — discharge released, awaiting cleaning</span>
        <span className="item"><span className="swatch cleaning" /> Cleaning in progress</span>
        <span className="item"><span className="swatch vacant" /> Vacant & ready</span>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Priority Queue — Awaiting Cleaning</h3>
          <div className="card-sub">Sorted by longest-waiting first (typically just-discharged beds)</div>
          {dirty.length === 0 && <div className="empty-state">Nothing waiting — all clear.</div>}
          {dirty.map((b) => {
            const lastRelease = housekeepingLog.find((l) => l.bedId === b.id && l.action === 'discharge_release');
            return (
              <div key={b.id} className="task-row">
                <div className="stripe dirty" />
                <div className="info">
                  <div className="bedname">{b.ward} · {b.bedNo}</div>
                  <div className="meta">
                    {lastRelease ? 'Discharge released' : 'Vacated'} {timeSince(b.statusSince)}
                    {lastRelease && <> · by {lastRelease.by}</>}
                  </div>
                </div>
                <Badge tone="danger">Dirty</Badge>
                <button className="btn btn-sm btn-primary" onClick={() => startCleaning(b.id)}>Start Cleaning</button>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3>In Progress</h3>
          <div className="card-sub">Beds currently being cleaned</div>
          {inProgress.length === 0 && <div className="empty-state">No active cleaning tasks.</div>}
          {inProgress.map((b) => (
            <div key={b.id} className="task-row">
              <div className="stripe cleaning" />
              <div className="info">
                <div className="bedname">{b.ward} · {b.bedNo}</div>
                <div className="meta">Started {timeSince(b.statusSince)}</div>
              </div>
              <Badge tone="warn">Cleaning</Badge>
              <button className="btn btn-sm btn-primary" onClick={() => completeCleaning(b.id)}>Mark Clean & Ready</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Ward Turnover Map</h3>
        <div className="card-sub">Full bed status, color-coded — click a dirty or cleaning bed to act on it</div>
        {wards.map((ward) => (
          <div key={ward} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8, color: 'var(--ink-soft)' }}>{ward}</div>
            <div className="bed-grid">
              {beds.filter((b) => b.ward === ward).map((b) => {
                const patient = patients.find((p) => p.id === b.patientId);
                return (
                  <div
                    key={b.id}
                    className={`bed-card ${b.status}`}
                    style={{ cursor: b.status === 'dirty' || b.status === 'cleaning' ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (b.status === 'dirty') startCleaning(b.id);
                      else if (b.status === 'cleaning') completeCleaning(b.id);
                    }}
                  >
                    <div className="bno">{b.bedNo}</div>
                    <div className="bst">{b.status}</div>
                    {patient && <div className="bwho">{patient.name}</div>}
                    <div className="bwho">{timeSince(b.statusSince)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Recent Discharge Releases</h3>
        <div className="card-sub">Latest beds handed to housekeeping after discharge or transfer</div>
        <table className="table">
          <thead><tr><th>Time</th><th>Bed</th><th>Released By</th></tr></thead>
          <tbody>
            {recentReleases.map((entry) => {
              const bed = beds.find((b) => b.id === entry.bedId);
              return (
                <tr key={entry.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{new Date(entry.at).toLocaleString('en-IN')}</td>
                  <td>{bed ? `${bed.ward} · ${bed.bedNo}` : entry.bedId}</td>
                  <td>{entry.by}</td>
                </tr>
              );
            })}
            {recentReleases.length === 0 && <tr><td colSpan={3} className="empty-state">No discharge releases logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

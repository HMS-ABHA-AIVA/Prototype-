import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHospitalStore } from '../../store/useHospitalStore';
import { wasteCategoryGuide } from '../../data/wasteGuide';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import type { WasteBatch, WasteCategory, WasteStage } from '../../types';

const CATEGORY_LABEL: Record<WasteCategory, string> = {
  yellow: 'Yellow',
  red: 'Red',
  white: 'White',
  blue: 'Blue',
};

const STAGES: WasteStage[] = ['segregated', 'stored', 'pretreated', 'disposed'];
const STAGE_LABEL: Record<WasteStage, string> = {
  segregated: 'Segregated',
  stored: 'Stored',
  pretreated: 'Pre-treated',
  disposed: 'Disposed',
};

const DEPARTMENTS = ['General Ward A', 'General Ward B', 'ICU', 'OT', 'OPD', 'Lab', 'Pharmacy'];
const STORAGE_LOCATIONS = ['Central BMW Storage Room', 'OT Interim Storage'];

function timeSince(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function WasteManagementPage() {
  const { wasteBatches, moveToStorage, pretreatBatch, disposeBatch, loadWaste } = useHospitalStore();
  useEffect(() => { void loadWaste(); }, [loadWaste]);
  const [tab, setTab] = useState<'pipeline' | 'guide'>('pipeline');
  const [showSegregate, setShowSegregate] = useState(false);
  const [actionBatch, setActionBatch] = useState<{ batch: WasteBatch; action: 'store' | 'pretreat' | 'dispose' } | null>(null);

  const hoursHeld = (b: WasteBatch) => {
    const since = b.stage === 'segregated' ? b.segregatedAt : b.storedAt ?? b.segregatedAt;
    return (Date.now() - new Date(since).getTime()) / 3600000;
  };
  const overheld = wasteBatches.filter((b) => b.stage !== 'disposed' && hoursHeld(b) > 48);

  const totalWeightToday = wasteBatches.reduce((sum, b) => sum + b.weightKg, 0);
  const activeCount = wasteBatches.filter((b) => b.stage !== 'disposed').length;

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Biomedical Waste Management</h1>
          <div className="sub">Segregation → safe storage → onsite pre-treatment → disposal — CPCB color-coded scheme</div>
        </div>
        <div className="row">
          <Link to="/housekeeping" className="btn btn-sm">← Housekeeping</Link>
          <button className="btn btn-primary" onClick={() => setShowSegregate(true)}>+ Log Segregation</button>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="label">Active Batches</div><div className="value">{activeCount}</div></div>
        <div className="kpi"><div className="label">Total Weight Logged</div><div className="value">{totalWeightToday.toFixed(1)} kg</div></div>
        <div className="kpi" style={{ borderBottomColor: overheld.length ? 'var(--danger)' : 'var(--brand)' }}>
          <div className="label">Held &gt; 48h</div>
          <div className="value">{overheld.length}</div>
          <div className="sub">exceeds BMW storage limit</div>
        </div>
        <div className="kpi"><div className="label">Disposed</div><div className="value">{wasteBatches.filter((b) => b.stage === 'disposed').length}</div></div>
      </div>

      <div className="status-legend" style={{ marginBottom: 16 }}>
        <span className="item"><span className="waste-swatch yellow" /> Yellow — anatomical/infectious/chemical</span>
        <span className="item"><span className="waste-swatch red" /> Red — contaminated recyclables</span>
        <span className="item"><span className="waste-swatch white" /> White — sharps</span>
        <span className="item"><span className="waste-swatch blue" /> Blue — glassware/implants</span>
      </div>

      <div className="tabs">
        <div className={`tab${tab === 'pipeline' ? ' active' : ''}`} onClick={() => setTab('pipeline')}>Tracking Pipeline</div>
        <div className={`tab${tab === 'guide' ? ' active' : ''}`} onClick={() => setTab('guide')}>Segregation & Treatment Guide</div>
      </div>

      {tab === 'pipeline' && (
        <>
          {overheld.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
              <div className="flex-between">
                <div>
                  <h3 style={{ color: 'var(--danger)' }}>⚠ Storage time exceeded</h3>
                  <div className="card-sub" style={{ color: '#7F1D1D' }}>
                    {overheld.length} batch(es) held over 48 hours without disposal — regulatory storage limit for bio-medical waste.
                  </div>
                </div>
              </div>
            </div>
          )}

          {wasteBatches.slice().reverse().map((b) => (
            <div key={b.id} className={`waste-card ${b.category}`}>
              <div className="flex-between">
                <div className="row">
                  <span className={`waste-swatch ${b.category}`} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{CATEGORY_LABEL[b.category]} bag · {b.department}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{b.weightKg} kg · segregated by {b.segregatedBy}, {timeSince(b.segregatedAt)}</div>
                  </div>
                </div>
                {b.stage !== 'disposed' && hoursHeld(b) > 48 && <Badge tone="danger">Over 48h</Badge>}
              </div>

              <div className="stage-pipeline">
                {STAGES.map((s, i) => (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1, gap: 4 }}>
                    <div className={`stage${STAGES.indexOf(b.stage) >= i ? ' done' : ''}`} style={{ flex: 1 }}>
                      {STAGE_LABEL[s]}
                    </div>
                    {i < STAGES.length - 1 && <span className="arrow">→</span>}
                  </div>
                ))}
              </div>

              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {b.storageLocation && <span style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>Stored: {b.storageLocation}</span>}
                {b.pretreatmentMethod && <span style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>· Pre-treated: {b.pretreatmentMethod}</span>}
                {b.disposalVendor && <span style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>· Disposed via {b.disposalVendor} (manifest {b.manifestNo})</span>}
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                {b.stage === 'segregated' && (
                  <button className="btn btn-sm btn-primary" onClick={() => setActionBatch({ batch: b, action: 'store' })}>
                    Move to Storage
                  </button>
                )}
                {b.stage === 'stored' && (
                  <>
                    <button className="btn btn-sm" onClick={() => setActionBatch({ batch: b, action: 'pretreat' })}>
                      Log Pre-treatment
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setActionBatch({ batch: b, action: 'dispose' })}>
                      Hand Over for Disposal
                    </button>
                  </>
                )}
                {b.stage === 'pretreated' && (
                  <button className="btn btn-sm btn-primary" onClick={() => setActionBatch({ batch: b, action: 'dispose' })}>
                    Hand Over for Disposal
                  </button>
                )}
                {b.stage === 'disposed' && <Badge tone="ok">Fully disposed — chain complete</Badge>}
              </div>
            </div>
          ))}
          {wasteBatches.length === 0 && <div className="empty-state">No waste batches logged yet.</div>}
        </>
      )}

      {tab === 'guide' && (
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Category</th><th>Examples</th><th>Container</th><th>Onsite Pre-treatment</th><th>Disposal</th></tr>
            </thead>
            <tbody>
              {wasteCategoryGuide.map((g) => (
                <tr key={g.category}>
                  <td><span className="row"><span className={`waste-swatch ${g.category}`} />{g.label}</span></td>
                  <td style={{ fontSize: 12.5 }}>{g.examples}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{g.container}</td>
                  <td style={{ fontSize: 12.5 }}>{g.requiresOnsitePretreatment ? g.pretreatmentMethod : <Badge tone="neutral">Not required</Badge>}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{g.disposalMethod}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sample-note">Reference: CPCB Bio-Medical Waste Management Rules, 2016 (Schedule I) color-coded segregation scheme. Validate against current CPCB/SPCB guidance at implementation time.</p>
        </div>
      )}

      {showSegregate && <SegregateModal onClose={() => setShowSegregate(false)} />}
      {actionBatch && (
        <BatchActionModal
          batch={actionBatch.batch}
          action={actionBatch.action}
          onClose={() => setActionBatch(null)}
          onStore={(loc) => { moveToStorage(actionBatch.batch.id, loc); setActionBatch(null); }}
          onPretreat={(method) => { pretreatBatch(actionBatch.batch.id, method); setActionBatch(null); }}
          onDispose={(vendor, manifest) => { disposeBatch(actionBatch.batch.id, vendor, manifest); setActionBatch(null); }}
        />
      )}
    </>
  );
}

function SegregateModal({ onClose }: { onClose: () => void }) {
  const { logSegregation } = useHospitalStore();
  const [category, setCategory] = useState<WasteCategory>('yellow');
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [weight, setWeight] = useState('1.0');

  return (
    <Modal title="Log Waste Segregation" onClose={onClose} width={440}>
      <div className="field">
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value as WasteCategory)}>
          <option value="yellow">Yellow — anatomical/infectious/chemical</option>
          <option value="red">Red — contaminated recyclables</option>
          <option value="white">White — sharps</option>
          <option value="blue">Blue — glassware/implants</option>
        </select>
      </div>
      <div className="two-col">
        <div className="field">
          <label>Department / Source</label>
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Weight (kg)</label>
          <input type="number" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </div>
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!Number(weight)}
          onClick={() => { logSegregation(category, department, Number(weight)); onClose(); }}
        >
          Log Batch
        </button>
      </div>
    </Modal>
  );
}

function BatchActionModal({
  batch,
  action,
  onClose,
  onStore,
  onPretreat,
  onDispose,
}: {
  batch: WasteBatch;
  action: 'store' | 'pretreat' | 'dispose';
  onClose: () => void;
  onStore: (location: string) => void;
  onPretreat: (method: string) => void;
  onDispose: (vendor: string, manifest: string) => void;
}) {
  const guide = wasteCategoryGuide.find((g) => g.category === batch.category)!;
  const [location, setLocation] = useState(STORAGE_LOCATIONS[0]);
  const [method, setMethod] = useState(guide.pretreatmentMethod);
  const [vendor, setVendor] = useState('SafeMed CBWTF Pvt. Ltd.');
  const [manifest, setManifest] = useState('');

  if (action === 'store') {
    return (
      <Modal title={`Move to Storage — ${CATEGORY_LABEL[batch.category]} batch`} onClose={onClose} width={420}>
        <div className="field">
          <label>Storage Location</label>
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            {STORAGE_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div className="flex-between" style={{ marginTop: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onStore(location)}>Confirm</button>
        </div>
      </Modal>
    );
  }

  if (action === 'pretreat') {
    return (
      <Modal title={`Log Pre-treatment — ${CATEGORY_LABEL[batch.category]} batch`} onClose={onClose} width={420}>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 14 }}>
          Recommended method for this category: <b>{guide.pretreatmentMethod}</b>
        </p>
        <div className="field">
          <label>Pre-treatment Method Used</label>
          <input value={method} onChange={(e) => setMethod(e.target.value)} />
        </div>
        <div className="flex-between" style={{ marginTop: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onPretreat(method)}>Confirm</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Hand Over for Disposal — ${CATEGORY_LABEL[batch.category]} batch`} onClose={onClose} width={440}>
      {batch.stage !== 'pretreated' && guide.requiresOnsitePretreatment && (
        <p style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 12 }}>
          Note: this category normally requires onsite pre-treatment ({guide.pretreatmentMethod}) before handover — confirm it was completed.
        </p>
      )}
      <div className="field">
        <label>Disposal Vendor / CBWTF</label>
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} />
      </div>
      <div className="field">
        <label>Manifest / Tracking No.</label>
        <input value={manifest} onChange={(e) => setManifest(e.target.value)} placeholder="e.g. BMW-2026-0001" />
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!vendor || !manifest} onClick={() => onDispose(vendor, manifest)}>
          Confirm Handover
        </button>
      </div>
    </Modal>
  );
}

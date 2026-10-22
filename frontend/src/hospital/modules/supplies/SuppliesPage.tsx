import { useEffect, useMemo, useState } from 'react';
import { useHospitalStore } from '../../store/useHospitalStore';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import type { Supply, SupplyCategory } from '../../types';

const CATEGORIES: SupplyCategory[] = [
  'Surgical Consumables',
  'PPE',
  'Linen & Housekeeping',
  'Equipment',
  'Stationery & Admin',
  'Diagnostic Consumables',
];

const DEPARTMENTS = ['General Ward A', 'General Ward B', 'ICU', 'OT', 'OPD', 'Housekeeping', 'Front Office'];

export function SuppliesPage() {
  const { supplies, supplyLog, staff, issueSupply, restockSupply, addSupply, loadSupplies, loadSupplyLog } = useHospitalStore();
  useEffect(() => { void loadSupplies(); void loadSupplyLog(); }, [loadSupplies, loadSupplyLog]);
  const [tab, setTab] = useState<'stock' | 'log'>('stock');
  const [category, setCategory] = useState<SupplyCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [issueTarget, setIssueTarget] = useState<Supply | null>(null);
  const [restockTarget, setRestockTarget] = useState<Supply | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const filtered = useMemo(() => {
    return supplies.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (query.trim() && !s.name.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [supplies, category, query]);

  const lowStockCount = supplies.filter((s) => s.stock <= s.reorderLevel).length;

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Supplies & Inventory</h1>
          <div className="sub">Non-pharmacy stock — surgical consumables, PPE, linen, equipment, stationery</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Item</button>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="label">Total Items</div><div className="value">{supplies.length}</div></div>
        <div className="kpi"><div className="label">Reorder Alerts</div><div className="value">{lowStockCount}</div></div>
        <div className="kpi"><div className="label">Categories</div><div className="value">{CATEGORIES.length}</div></div>
        <div className="kpi"><div className="label">Movements Logged</div><div className="value">{supplyLog.length}</div></div>
      </div>

      <div className="tabs">
        <div className={`tab${tab === 'stock' ? ' active' : ''}`} onClick={() => setTab('stock')}>Stock</div>
        <div className={`tab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>Issue / Restock Log</div>
      </div>

      {tab === 'stock' && (
        <>
          <div className="card">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search item…" style={{ maxWidth: 260 }} />
              <select value={category} onChange={(e) => setCategory(e.target.value as SupplyCategory | 'all')} style={{ maxWidth: 220 }}>
                <option value="all">All categories</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Location</th>
                  <th className="num">Stock</th>
                  <th className="num">Reorder Level</th>
                  <th>Last Restocked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const low = s.stock <= s.reorderLevel;
                  return (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>{s.name}</td>
                      <td><Badge tone="neutral">{s.category}</Badge></td>
                      <td style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{s.location}</td>
                      <td className="num mono">{s.stock} {s.unit}</td>
                      <td className="num mono">{s.reorderLevel}</td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
                        {new Date(s.lastRestockedAt).toLocaleDateString('en-IN')}
                      </td>
                      <td>
                        <div className="row">
                          {low && <Badge tone="danger">Reorder</Badge>}
                          <button className="btn btn-sm" onClick={() => setIssueTarget(s)}>Issue</button>
                          <button className="btn btn-sm" onClick={() => setRestockTarget(s)}>Restock</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && <tr><td colSpan={7} className="empty-state">No items match this filter.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'log' && (
        <div className="card">
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Item</th><th>Type</th><th className="num">Qty</th><th>Department / Location</th><th>By</th></tr>
            </thead>
            <tbody>
              {supplyLog.map((entry) => {
                const supply = supplies.find((s) => s.id === entry.supplyId);
                return (
                  <tr key={entry.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{new Date(entry.at).toLocaleString('en-IN')}</td>
                    <td style={{ fontWeight: 500 }}>{supply?.name ?? entry.supplyId}</td>
                    <td>{entry.type === 'issue' ? <Badge tone="info">Issued</Badge> : <Badge tone="ok">Restocked</Badge>}</td>
                    <td className="num mono">{entry.type === 'issue' ? '-' : '+'}{entry.qty}</td>
                    <td>{entry.department}</td>
                    <td>{entry.by}</td>
                  </tr>
                );
              })}
              {supplyLog.length === 0 && <tr><td colSpan={6} className="empty-state">No stock movements logged yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {issueTarget && (
        <IssueModal supply={issueTarget} onClose={() => setIssueTarget(null)} onConfirm={(qty, dept) => { issueSupply(issueTarget.id, qty, dept); setIssueTarget(null); }} />
      )}
      {restockTarget && (
        <RestockModal supply={restockTarget} onClose={() => setRestockTarget(null)} onConfirm={(qty) => { restockSupply(restockTarget.id, qty); setRestockTarget(null); }} />
      )}
      {showAdd && (
        <AddSupplyModal
          onClose={() => setShowAdd(false)}
          onSave={(data) => { addSupply(data); setShowAdd(false); }}
        />
      )}
      <p className="sample-note" style={{ marginTop: 4 }}>Staff on record: {staff.length} · demo data resets on full page reload.</p>
    </>
  );
}

function IssueModal({ supply, onClose, onConfirm }: { supply: Supply; onClose: () => void; onConfirm: (qty: number, dept: string) => void }) {
  const [qty, setQty] = useState('1');
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const qtyNum = Number(qty);
  const invalid = !qtyNum || qtyNum <= 0 || qtyNum > supply.stock;

  return (
    <Modal title={`Issue — ${supply.name}`} onClose={onClose} width={440}>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 14 }}>
        Current stock: <b className="mono">{supply.stock} {supply.unit}</b> at {supply.location}
      </p>
      <div className="two-col">
        <div className="field">
          <label>Quantity</label>
          <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div className="field">
          <label>Issue To (Department)</label>
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>
      {invalid && qtyNum > supply.stock && (
        <p style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: -8, marginBottom: 12 }}>Cannot issue more than current stock.</p>
      )}
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={invalid} onClick={() => onConfirm(qtyNum, department)}>Confirm Issue</button>
      </div>
    </Modal>
  );
}

function RestockModal({ supply, onClose, onConfirm }: { supply: Supply; onClose: () => void; onConfirm: (qty: number) => void }) {
  const [qty, setQty] = useState('50');
  const qtyNum = Number(qty);
  const invalid = !qtyNum || qtyNum <= 0;

  return (
    <Modal title={`Restock — ${supply.name}`} onClose={onClose} width={400}>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 14 }}>
        Current stock: <b className="mono">{supply.stock} {supply.unit}</b>
      </p>
      <div className="field">
        <label>Quantity Received</label>
        <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={invalid} onClick={() => onConfirm(qtyNum)}>Confirm Restock</button>
      </div>
    </Modal>
  );
}

function AddSupplyModal({ onClose, onSave }: { onClose: () => void; onSave: (data: Omit<Supply, 'id' | 'lastRestockedAt'>) => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<SupplyCategory>(CATEGORIES[0]);
  const [unit, setUnit] = useState('pc');
  const [stock, setStock] = useState('0');
  const [reorderLevel, setReorderLevel] = useState('10');
  const [location, setLocation] = useState('Central Store');

  const invalid = !name.trim();

  return (
    <Modal title="Add Supply Item" onClose={onClose} width={480}>
      <div className="field">
        <label>Item Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nebulizer Kit" autoFocus />
      </div>
      <div className="two-col">
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as SupplyCategory)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Unit</label>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="pc / box / kit" />
        </div>
        <div className="field">
          <label>Opening Stock</label>
          <input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
        </div>
        <div className="field">
          <label>Reorder Level</label>
          <input type="number" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Storage Location</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div className="flex-between" style={{ marginTop: 6 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={invalid}
          onClick={() => onSave({ name, category, unit, stock: Number(stock), reorderLevel: Number(reorderLevel), location })}
        >
          Add Item
        </button>
      </div>
    </Modal>
  );
}

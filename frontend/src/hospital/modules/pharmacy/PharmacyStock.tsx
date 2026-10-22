import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import * as pharmacy from '../../api/pharmacy';
import { day } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { rupees } from '../opdbilling/BillingFields';

const num = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(/,/g, '')));
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const notify = (m: string) => useNoticeStore.getState().show(m, 'info');

function Failure({ message }: { message: string | null }) {
  return message ? <div className="login-error" role="alert">{message}</div> : null;
}

// ---- Stock -----------------------------------------------------------------------------------------------------------------------

/** Items with what is in stock, then every batch with its expiry, price and worth. Stock is changed by purchases and sales; here it can be written off. */
export function StockTab() {
  const [items, setItems] = useState<pharmacy.DrugItem[]>([]);
  const [report, setReport] = useState<pharmacy.StockReport | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'items' | 'batches'>('batches');
  const [editing, setEditing] = useState<pharmacy.DrugItem | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<pharmacy.StockBatch | null>(null);
  const load = useCallback(() => {
    pharmacy.fetchItems().then(setItems, reportError);
    pharmacy.fetchStock().then(setReport, reportError);
  }, []);
  useEffect(load, [load]);

  const match = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());
  const t = report?.totals;
  return (
    <>
      {t && (
        <div className="kpi-row">
          <div className="kpi"><div className="label">Units in stock</div><div className="value">{t.units.toLocaleString('en-IN')}</div></div>
          <div className="kpi"><div className="label">Worth at cost</div><div className="value">{rupees(t.costValue)}</div>{t.unknownCostUnits > 0 && <div className="rx-small">+ {t.unknownCostUnits} units with no known cost</div>}</div>
          <div className="kpi"><div className="label">Worth at MRP</div><div className="value">{rupees(t.mrpValue)}</div></div>
          <div className="kpi"><div className="label">Expired</div><div className="value" style={t.expiredUnits ? { color: 'var(--danger)' } : undefined}>{t.expiredUnits}</div><div className="rx-small">{t.expiredUnits ? `${rupees(t.expiredValue)} to write off` : 'none'}</div></div>
          <div className="kpi"><div className="label">Expiring in 90 days</div><div className="value">{t.nearExpiryUnits}</div></div>
        </div>
      )}
      <div className="card">
        <div className="flex-between">
          <div className="row">
            <button className={`btn btn-sm${view === 'batches' ? ' btn-primary' : ''}`} onClick={() => setView('batches')}>By batch</button>
            <button className={`btn btn-sm${view === 'items' ? ' btn-primary' : ''}`} onClick={() => setView('items')}>Medicine list</button>
            <input style={{ width: 240 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Add a medicine</button>
        </div>

        {view === 'batches' && report && (
          <table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th className="num">Qty</th><th className="num">MRP</th><th className="num">Cost / unit</th><th className="num">Value (cost)</th><th></th></tr></thead>
            <tbody>
              {report.batches.filter((b) => match(b.name)).map((b) => (
                <tr key={b.batchId}>
                  <td>{b.name}</td><td className="mono">{b.batchNo}</td>
                  <td className="mono">{day(b.expiry)} {b.state === 'expired' ? <Badge tone="danger">Expired</Badge> : b.state === 'near' ? <Badge tone="warn">Soon</Badge> : null}</td>
                  <td className="num mono">{b.qty} {b.unit}</td><td className="num mono">{rupees(b.mrp)}</td>
                  <td className="num mono">{b.purchaseRate !== null ? rupees(b.purchaseRate) : '—'}</td><td className="num mono">{b.costValue !== null ? rupees(b.costValue) : '—'}</td>
                  <td><button className="btn btn-sm" onClick={() => setAdjusting(b)}>Adjust</button></td>
                </tr>
              ))}
              {report.batches.length === 0 && <tr><td colSpan={8} className="empty-state">Nothing is in stock. Enter a purchase to receive stock.</td></tr>}
            </tbody>
          </table>
        )}

        {view === 'items' && (
          <table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>Medicine</th><th className="num">In stock</th><th className="num">Reorder at</th><th className="num">MRP</th><th className="num">GST</th><th>HSN</th><th></th></tr></thead>
            <tbody>
              {items.filter((i) => match(i.name)).map((i) => (
                <tr key={i.id}>
                  <td>{i.name}{i.stock <= i.reorderLevel && <> <Badge tone="danger">Reorder</Badge></>}{i.expiredQty > 0 && <> <Badge tone="warn">{i.expiredQty} expired</Badge></>}</td>
                  <td className="num mono">{i.stock} {i.unit}</td><td className="num">{i.reorderLevel}</td><td className="num mono">{rupees(i.mrp)}</td><td className="num">{i.gstPct}%</td><td className="mono">{i.hsnCode}</td>
                  <td><button className="btn btn-sm" onClick={() => setEditing(i)}>Edit</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="empty-state">No medicines yet. Add one, or enter a purchase.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ItemDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {adjusting && <AdjustDialog batch={adjusting} onClose={() => setAdjusting(null)} onSaved={() => { setAdjusting(null); load(); }} />}
    </>
  );
}

function ItemDialog({ item, onClose, onSaved }: { item: pharmacy.DrugItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [unit, setUnit] = useState(item?.unit ?? 'tab');
  const [reorder, setReorder] = useState(String(item?.reorderLevel ?? 20));
  const [mrp, setMrp] = useState(String(item?.defaultMrp ?? ''));
  const [gst, setGst] = useState(String(item?.gstPct ?? 12));
  const [hsn, setHsn] = useState(item?.hsnCode ?? '3004');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = name.trim().length < 1 || !unit.trim() || !(num(reorder) >= 0) || !(num(mrp) >= 0) || !(num(gst) >= 0 && num(gst) <= 100) || !/^\d{4,8}$/.test(hsn);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), unit: unit.trim(), reorderLevel: Math.floor(num(reorder)), mrp: num(mrp), gstPct: num(gst), hsnCode: hsn };
      if (item) await pharmacy.updateItem(item.id, body);
      else await pharmacy.createItem(body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add a medicine'} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="field"><label>Name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus placeholder="e.g. Paracetamol 500mg" /></div>
        <div className="two-col">
          <div className="field"><label>Unit *</label><input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="tab, cap, strip, vial ..." /></div>
          <div className="field"><label>Reorder when stock is at or below</label><input type="number" min={0} value={reorder} onChange={(e) => setReorder(e.target.value)} /></div>
        </div>
        <div className="two-col">
          <div className="field"><label>Usual MRP per unit (₹)</label><input type="number" min={0} step="0.01" value={mrp} onChange={(e) => setMrp(e.target.value)} /><div className="ai-hint">Each batch has its own MRP from its purchase. This is used when there is no batch.</div></div>
          <div className="field"><label>GST %</label><input type="number" min={0} max={100} value={gst} onChange={(e) => setGst(e.target.value)} /></div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}><label>HSN code</label><input value={hsn} onChange={(e) => setHsn(e.target.value)} maxLength={8} /><div className="ai-hint">3004 for medicines.</div></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdjustDialog({ batch, onClose, onSaved }: { batch: pharmacy.StockBatch; onClose: () => void; onSaved: () => void }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState(batch.state === 'expired' ? 'Expired: written off' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = Math.trunc(num(delta));
  const invalid = !change || change + batch.qty < 0 || reason.trim().length < 3;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await pharmacy.adjustBatch(batch.batchId, change, reason.trim());
      notify('Stock adjusted');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Adjust ${batch.name} · batch ${batch.batchNo}`} onClose={onClose} width={480}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="ai-hint" style={{ marginBottom: 8 }}>On the shelf: <b>{batch.qty} {batch.unit}</b>. Enter a negative number to write units off (damage, expiry, a count that did not match), a positive one to add back.</div>
        <div className="field"><label>Change (units) *</label><input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus placeholder={batch.state === 'expired' ? `-${batch.qty}` : '-3'} /></div>
        <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></div>
        {change + batch.qty < 0 && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>That is more than the {batch.qty} in this batch.</div>}
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Suppliers ------------------------------------------------------------------------------------------------------------------------

export function SuppliersTab() {
  const [rows, setRows] = useState<pharmacy.Supplier[]>([]);
  const [editing, setEditing] = useState<pharmacy.Supplier | 'new' | null>(null);
  const load = useCallback(() => { pharmacy.fetchSuppliers(true).then(setRows, reportError); }, []);
  useEffect(load, [load]);
  return (
    <div className="card">
      <div className="flex-between"><div><h3>Suppliers</h3><div className="card-sub">Who the pharmacy buys from</div></div><button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Add a supplier</button></div>
      <table className="table">
        <thead><tr><th>Name</th><th>GSTIN</th><th>Drug licence</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}><td><b>{s.name}</b></td><td className="mono">{s.gstin ?? '—'}</td><td>{s.drugLicense ?? '—'}</td><td>{s.phone ?? '—'}</td><td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Off</Badge>}</td><td><button className="btn btn-sm" onClick={() => setEditing(s)}>Edit</button></td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="empty-state">No suppliers yet.</td></tr>}
        </tbody>
      </table>
      {editing && <SupplierDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: pharmacy.Supplier | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(supplier?.name ?? '');
  const [gstin, setGstin] = useState(supplier?.gstin ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [licence, setLicence] = useState(supplier?.drugLicense ?? '');
  const [address, setAddress] = useState(supplier?.address ?? '');
  const [active, setActive] = useState(supplier?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || name.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await pharmacy.saveSupplier({ name: name.trim(), gstin: gstin.trim() || null, phone: phone.trim() || null, drugLicense: licence.trim() || null, address: address.trim() || null, ...(supplier ? { active } : {}) }, supplier?.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setBusy(false);
    }
  };
  return (
    <Modal title={supplier ? `Edit ${supplier.name}` : 'Add a supplier'} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="field"><label>Name *</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></div>
        <div className="two-col">
          <div className="field"><label>GSTIN</label><input value={gstin} onChange={(e) => setGstin(e.target.value)} maxLength={15} /></div>
          <div className="field"><label>Drug licence no.</label><input value={licence} onChange={(e) => setLicence(e.target.value)} maxLength={60} /></div>
        </div>
        <div className="two-col">
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} /></div>
          <div className="field"><label>Address</label><input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></div>
        </div>
        {supplier && <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" style={{ width: 'auto' }} checked={active} onChange={(e) => setActive(e.target.checked)} />Active</label>}
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Purchases ------------------------------------------------------------------------------------------------------------------------

export function PurchasesTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof pharmacy.fetchPurchases>> | null>(null);
  const [unpaid, setUnpaid] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useCallback(() => { pharmacy.fetchPurchases({ unpaid }).then(setData, reportError); }, [unpaid]);
  useEffect(load, [load]);

  return (
    <div className="card">
      <div className="flex-between">
        <div><h3>Purchases</h3><div className="card-sub">Supplier invoices received. Receiving one puts the units into their batches.</div></div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Enter a purchase</button>
      </div>
      <label className="row" style={{ cursor: 'pointer', marginBottom: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} />Only those with something still to pay{data ? ` (owed in total: ${rupees(data.totals.due)})` : ''}</label>
      <table className="table">
        <thead><tr><th>Entry</th><th>Supplier</th><th>Their invoice</th><th>Date</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Due</th><th></th></tr></thead>
        <tbody>
          {data?.purchases.map((p) => (
            <tr key={p.id} style={p.status === 'cancelled' ? { opacity: 0.5 } : undefined}>
              <td className="mono">{p.purchaseNo}{p.status === 'cancelled' && <> <Badge tone="danger">Cancelled</Badge></>}</td><td>{p.supplierName}</td><td>{p.supplierInvoiceNo}</td><td>{day(p.invoiceDate)}</td>
              <td className="num mono">{rupees(p.total)}</td><td className="num mono">{rupees(p.amountPaid)}</td><td className="num mono">{p.due > 0 ? <b>{rupees(p.due)}</b> : '—'}</td>
              <td><button className="btn btn-sm" onClick={() => setViewing(p.id)}>Open</button></td>
            </tr>
          ))}
          {data && data.purchases.length === 0 && <tr><td colSpan={8} className="empty-state">No purchases yet.</td></tr>}
        </tbody>
      </table>
      {adding && <PurchaseDialog onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); notify('Purchase received into stock'); }} />}
      {viewing && <PurchaseView id={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </div>
  );
}

interface Line {
  key: number
  name: string
  drugId?: string
  unit: string
  gst: string
  batchNo: string
  expiry: string
  qty: string
  free: string
  rate: string
  mrp: string
}
let lineKey = 1;
const blankLine = (): Line => ({ key: lineKey++, name: '', unit: 'tab', gst: '12', batchNo: '', expiry: '', qty: '', free: '0', rate: '', mrp: '' });

/** "12/2027", "03/27", "31-03-2027" or "2027-03-31" as a date; a month alone means its last day. Null when it cannot be read. */
export function parseExpiry(text: string): string | null {
  const s = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    const month = Number(m[1]);
    if (month < 1 || month > 12) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  }
  return null;
}

/** Splits one line of a CSV file into fields, honouring "quoted, fields". */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const HEADERS: Record<string, keyof Line | 'ignore'> = {
  medicine: 'name', drug: 'name', item: 'name', name: 'name', product: 'name', description: 'name',
  batch: 'batchNo', batchno: 'batchNo', batch_no: 'batchNo', 'batch no': 'batchNo',
  expiry: 'expiry', exp: 'expiry', expirydate: 'expiry', expiry_date: 'expiry', 'expiry date': 'expiry',
  qty: 'qty', quantity: 'qty', free: 'free', freeqty: 'free', free_qty: 'free', 'free qty': 'free',
  rate: 'rate', ptr: 'rate', purchaserate: 'rate', purchase_rate: 'rate', 'purchase rate': 'rate', cost: 'rate', price: 'rate',
  mrp: 'mrp', gst: 'gst', gstpct: 'gst', gst_pct: 'gst', tax: 'gst', unit: 'unit', pack: 'unit',
};

/** Reads a supplier bill from a spreadsheet saved as CSV (or pasted). The first row names the columns: medicine, batch, expiry, qty, rate, mrp, and optionally free, gst, unit. */
export function parseBillCsv(text: string, items: pharmacy.DrugItem[]): { lines: Line[]; problems: string[] } {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(splitCsv);
  if (rows.length < 2) return { lines: [], problems: ['The file needs a header row and at least one line.'] };
  const columns = rows[0]!.map((h) => HEADERS[h.toLowerCase().replace(/[^a-z_ ]/g, '')]);
  const needed: (keyof Line)[] = ['name', 'batchNo', 'expiry', 'qty', 'rate', 'mrp'];
  const missing = needed.filter((n) => !columns.includes(n));
  if (missing.length) return { lines: [], problems: [`Missing column(s): ${missing.map((m) => ({ batchNo: 'batch', name: 'medicine' } as Record<string, string>)[m] ?? m).join(', ')}.`] };
  const problems: string[] = [];
  const lines = rows.slice(1).map((cells, n) => {
    const line = blankLine();
    columns.forEach((col, i) => { if (col && col !== 'ignore') (line as unknown as Record<string, string>)[col] = cells[i] ?? ''; });
    const expiry = parseExpiry(line.expiry);
    if (!expiry) problems.push(`Line ${n + 2}: the expiry "${line.expiry}" could not be read.`);
    line.expiry = expiry ?? '';
    const found = items.find((i) => i.name.toLowerCase() === line.name.trim().toLowerCase());
    if (found) { line.drugId = found.id; line.unit = found.unit; if (!columns.includes('gst')) line.gst = String(found.gstPct); }
    if (!line.free) line.free = '0';
    if (!line.gst) line.gst = '12';
    return line;
  });
  return { lines, problems };
}

function PurchaseDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [suppliers, setSuppliers] = useState<pharmacy.Supplier[]>([]);
  const [items, setItems] = useState<pharmacy.DrugItem[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [paid, setPaid] = useState('');
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank' | 'other'>('bank');
  const [reference, setReference] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pharmacy.fetchSuppliers().then((s) => { setSuppliers(s); if (s[0]) setSupplierId((cur) => cur || s[0]!.id); }, reportError);
    pharmacy.fetchItems().then(setItems, reportError);
  }, []);

  const setLine = (key: number, change: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const nameChanged = (key: number, name: string) => {
    const found = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
    setLine(key, { name, drugId: found?.id, ...(found ? { unit: found.unit, gst: String(found.gstPct), mrp: '' } : {}) });
  };

  const usable = lines.filter((l) => l.name.trim() || l.batchNo.trim() || l.qty.trim());
  const lineProblem = (l: Line) =>
    !l.name.trim() ? 'medicine' : !l.batchNo.trim() ? 'batch' : !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry) ? 'expiry' : !(num(l.qty) >= 1) ? 'qty' : !(num(l.rate) >= 0) ? 'rate' : !(num(l.mrp) >= 0) ? 'MRP' : !(num(l.gst) >= 0 && num(l.gst) <= 100) ? 'GST' : null;
  const taxable = usable.reduce((s, l) => s + (num(l.qty) || 0) * (num(l.rate) || 0), 0);
  const gst = usable.reduce((s, l) => s + ((num(l.qty) || 0) * (num(l.rate) || 0) * (num(l.gst) || 0)) / 100, 0);
  const total = Math.round((taxable + gst) * 100) / 100;
  const blocked = !supplierId || !invoiceNo.trim() || usable.length === 0 || usable.some((l) => lineProblem(l)) || (paid.trim() !== '' && (!(num(paid) >= 0) || num(paid) > total));

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseBillCsv(await file.text(), items);
    setProblems(parsed.problems);
    if (parsed.lines.length) setLines(parsed.lines);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await pharmacy.createPurchase({
        supplierId, supplierInvoiceNo: invoiceNo.trim(), invoiceDate,
        items: usable.map((l) => ({
          ...(l.drugId ? { drugId: l.drugId } : { newDrug: { name: l.name.trim(), unit: l.unit.trim() || 'unit', reorderLevel: 0, gstPct: num(l.gst), mrp: num(l.mrp) } }),
          batchNo: l.batchNo.trim(), expiry: l.expiry, qty: Math.floor(num(l.qty)), freeQty: Math.floor(num(l.free) || 0), purchaseRate: num(l.rate), mrp: num(l.mrp), gstPct: num(l.gst),
        })),
        ...(num(paid) > 0 ? { payment: { amount: num(paid), mode, reference: reference.trim() || undefined } } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the purchase');
      setBusy(false);
    }
  };

  const datalist = useMemo(() => items.map((i) => <option key={i.id} value={i.name} />), [items]);
  return (
    <Modal title="Enter a supplier's invoice" onClose={onClose} width={1000}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="two-col">
          <div className="field"><label>Supplier *</label><select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>{suppliers.length === 0 && <div className="ai-hint">Add a supplier first (Suppliers tab).</div>}</div>
          <div className="two-col">
            <div className="field"><label>Their invoice no. *</label><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} /></div>
            <div className="field"><label>Invoice date *</label><input type="date" value={invoiceDate} max={today()} onChange={(e) => setInvoiceDate(e.target.value)} /></div>
          </div>
        </div>
        <div className="field">
          <label>Import the bill from a spreadsheet (CSV)</label>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void importFile(e.target.files?.[0])} />
          <div className="ai-hint">First row: medicine, batch, expiry, qty, rate, mrp (optional: free, gst, unit). Review the lines below, then save. Medicines not in the stock list are added.</div>
          {problems.map((p) => <div key={p} style={{ color: 'var(--danger)', fontSize: 12.5 }}>{p}</div>)}
        </div>
        <datalist id="purchase-items">{datalist}</datalist>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th className="num">Qty</th><th className="num">Free</th><th className="num">Rate (before GST)</th><th className="num">MRP</th><th className="num">GST%</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} title={usable.includes(l) ? lineProblem(l) ? `Check: ${lineProblem(l)}` : undefined : undefined}>
                  <td style={{ minWidth: 200 }}><input list="purchase-items" value={l.name} onChange={(e) => nameChanged(l.key, e.target.value)} placeholder="Medicine" />{l.name.trim() && !l.drugId && <div className="rx-small" style={{ color: 'var(--warn)' }}>New medicine · unit <input style={{ width: 60 }} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} /></div>}</td>
                  <td><input style={{ width: 90 }} value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} /></td>
                  <td><input type="date" value={l.expiry} onChange={(e) => setLine(l.key, { expiry: e.target.value })} /></td>
                  <td className="num"><input type="number" min={1} style={{ width: 70, textAlign: 'right' }} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} /></td>
                  <td className="num"><input type="number" min={0} style={{ width: 60, textAlign: 'right' }} value={l.free} onChange={(e) => setLine(l.key, { free: e.target.value })} /></td>
                  <td className="num"><input type="number" min={0} step="0.01" style={{ width: 90, textAlign: 'right' }} value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} /></td>
                  <td className="num"><input type="number" min={0} step="0.01" style={{ width: 80, textAlign: 'right' }} value={l.mrp} onChange={(e) => setLine(l.key, { mrp: e.target.value })} /></td>
                  <td className="num"><input type="number" min={0} max={100} style={{ width: 60, textAlign: 'right' }} value={l.gst} onChange={(e) => setLine(l.key, { gst: e.target.value })} /></td>
                  <td><button type="button" className="btn btn-ghost btn-sm" aria-label="Remove line" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, blankLine()])}>+ Add a line</button>
        <div className="two-col" style={{ marginTop: 12 }}>
          <div>
            <div className="field"><label>Paid now (₹, optional)</label><input type="number" min={0} value={paid} onChange={(e) => setPaid(e.target.value)} /></div>
            {num(paid) > 0 && (
              <div className="two-col">
                <div className="field"><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="other">Other</option></select></div>
                <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></div>
              </div>
            )}
          </div>
          <table className="invoice-totals" style={{ marginLeft: 'auto' }}>
            <tbody>
              <tr><td>Taxable</td><td className="mono">{rupees(taxable)}</td></tr><tr><td>GST</td><td className="mono">{rupees(gst)}</td></tr>
              <tr className="invoice-net"><td>Invoice total</td><td className="mono">{rupees(total)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || blocked}>{busy ? 'Saving…' : 'Receive into stock'}</button>
        </div>
      </form>
    </Modal>
  );
}

function PurchaseView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<pharmacy.PurchaseDetail | null>(null);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank' | 'other'>('bank');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { pharmacy.fetchPurchase(id).then(setP, reportError); }, [id]);

  const run = async (work: () => Promise<pharmacy.PurchaseDetail>, message: string) => {
    setError(null);
    try {
      setP(await work());
      setPaying(false);
      setCancelling(false);
      notify(message);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not do that');
    }
  };

  if (!p) return null;
  return (
    <Modal title={`${p.purchaseNo} · ${p.supplierName}`} onClose={onClose} width={860}>
      <Failure message={error} />
      <p style={{ fontSize: 13 }}>Their invoice <b>{p.supplierInvoiceNo}</b> dated {day(p.invoiceDate)} · entered by {p.createdBy} {p.status === 'cancelled' && <Badge tone="danger">Cancelled: {p.cancelReason}</Badge>}</p>
      <table className="table">
        <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th className="num">Qty</th><th className="num">Free</th><th className="num">Rate</th><th className="num">MRP</th><th className="num">GST</th><th className="num">Taxable</th></tr></thead>
        <tbody>{p.items.map((i) => <tr key={i.id}><td>{i.drugName}</td><td className="mono">{i.batchNo}</td><td>{day(i.expiry)}</td><td className="num">{i.qty}</td><td className="num">{i.freeQty}</td><td className="num mono">{rupees(i.purchaseRate)}</td><td className="num mono">{rupees(i.mrp)}</td><td className="num">{i.gstPct}%</td><td className="num mono">{rupees(i.taxable)}</td></tr>)}</tbody>
      </table>
      <table className="invoice-totals">
        <tbody>
          <tr><td>Taxable</td><td className="mono">{rupees(p.taxable)}</td></tr><tr><td>GST</td><td className="mono">{rupees(p.gstTotal)}</td></tr>
          <tr className="invoice-net"><td>Total</td><td className="mono">{rupees(p.total)}</td></tr><tr><td>Paid</td><td className="mono">{rupees(p.amountPaid)}</td></tr>
          <tr><td><b>Still to pay</b></td><td className="mono"><b>{rupees(p.due)}</b></td></tr>
        </tbody>
      </table>
      {p.status === 'received' && !paying && !cancelling && (
        <div className="row" style={{ marginTop: 12 }}>
          {p.due > 0 && <button className="btn btn-primary" onClick={() => { setPaying(true); setAmount(String(p.due)); }}>Record a payment to the supplier</button>}
          <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel this purchase</button>
        </div>
      )}
      {paying && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="two-col">
            <div className="field"><label>Amount (₹)</label><input type="number" min={0} max={p.due} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div className="field"><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="other">Other</option></select></div>
          </div>
          <div className="field"><label>Reference</label><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></div>
          <div className="row"><button className="btn btn-ghost" onClick={() => setPaying(false)}>Back</button><button className="btn btn-primary" disabled={!(num(amount) > 0) || num(amount) > p.due} onClick={() => run(() => pharmacy.paySupplier(p.id, { amount: num(amount), mode, reference: reference.trim() || undefined }), 'Payment recorded')}>Record payment</button></div>
        </div>
      )}
      {cancelling && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="ai-hint">Takes these units back out of stock. It is refused if any of them has already been sold or written off.</p>
          <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></div>
          <div className="row"><button className="btn btn-ghost" onClick={() => setCancelling(false)}>Back</button><button className="btn btn-primary" disabled={reason.trim().length < 3} onClick={() => run(() => pharmacy.cancelPurchase(p.id, reason.trim()), 'Purchase cancelled')}>Cancel the purchase</button></div>
        </div>
      )}
    </Modal>
  );
}

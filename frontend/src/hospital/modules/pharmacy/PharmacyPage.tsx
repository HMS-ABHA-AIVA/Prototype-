import { useCallback, useEffect, useState } from 'react';
import * as pharmacy from '../../api/pharmacy';
import { day, when } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { rupees } from '../opdbilling/BillingFields';
import { CancelSaleDialog, CounterSaleTab, PharmacyInvoicePrint } from './PharmacySell';
import { PurchasesTab, StockTab, SuppliersTab } from './PharmacyStock';

type Tab = 'dashboard' | 'queue' | 'sell' | 'sales' | 'stock' | 'purchases' | 'suppliers' | 'reports';
const TABS: [Tab, string][] = [
  ['dashboard', 'Dashboard'], ['queue', 'Dispense queue'], ['sell', 'Counter sale'], ['sales', 'Sales & invoices'], ['stock', 'Stock'],
  ['purchases', 'Purchases'], ['suppliers', 'Suppliers'], ['reports', 'GST & profit'],
];

const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const monthStart = () => `${todayIst().slice(0, 8)}01`;

/**
 * The pharmacy: what is waiting to be dispensed, counter sales with GST invoices, batch-wise stock with expiry and value, supplier purchases
 * (including importing a bill from a spreadsheet), and the GST and profit reports.
 */
export function PharmacyPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <>
      <div className="os-head">
        <div>
          <h1>Pharmacy & Inventory</h1>
          <div className="sub">Dispensing, counter sales, batch-wise stock, purchases, GST</div>
        </div>
      </div>
      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {TABS.map(([key, label]) => <div key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</div>)}
      </div>
      {tab === 'dashboard' && <DashboardTab go={setTab} />}
      {tab === 'queue' && <QueueTab />}
      {tab === 'sell' && <CounterSaleTab />}
      {tab === 'sales' && <SalesTab />}
      {tab === 'stock' && <StockTab />}
      {tab === 'purchases' && <PurchasesTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'reports' && <ReportsTab />}
    </>
  );
}

// ---- Dashboard -----------------------------------------------------------------------------------------------------------------------

function DashboardTab({ go }: { go: (tab: Tab) => void }) {
  const [d, setD] = useState<pharmacy.Dashboard | null>(null);
  useEffect(() => { pharmacy.fetchDashboard().then(setD, reportError); }, []);
  if (!d) return <div className="empty-state">Loading…</div>;
  const peak = Math.max(1, ...d.lastSevenDays.map((x) => x.total));
  return (
    <>
      <div className="kpi-row">
        <div className="kpi"><div className="label">Counter sales today</div><div className="value">{rupees(d.todayCounterSales.total)}</div><div className="rx-small">{d.todayCounterSales.n} invoice{d.todayCounterSales.n === 1 ? '' : 's'}</div></div>
        <div className="kpi"><div className="label">Dispensed to patients today</div><div className="value">{rupees(d.todayDispensed.total)}</div><div className="rx-small">{d.todayDispensed.n} issue{d.todayDispensed.n === 1 ? '' : 's'}</div></div>
        <div className="kpi" style={{ cursor: 'pointer' }} onClick={() => go('queue')}><div className="label">Waiting to dispense</div><div className="value">{d.prescriptionsWaiting}</div></div>
        <div className="kpi"><div className="label">Stock at cost</div><div className="value">{rupees(d.stock.costValue)}</div><div className="rx-small">at MRP {rupees(d.stock.mrpValue)}</div></div>
        <div className="kpi"><div className="label">Owed to suppliers</div><div className="value">{rupees(d.owedToSuppliers)}</div></div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Running low</h3>
          <table className="table">
            <thead><tr><th>Medicine</th><th className="num">In stock</th><th className="num">Reorder at</th></tr></thead>
            <tbody>
              {d.lowStock.map((l) => <tr key={l.id}><td>{l.name}</td><td className="num mono"><b>{l.stock}</b> {l.unit}</td><td className="num">{l.reorderLevel}</td></tr>)}
              {d.lowStock.length === 0 && <tr><td colSpan={3} className="empty-state">Nothing is below its reorder level.</td></tr>}
            </tbody>
          </table>
          {(d.stock.expiredUnits > 0 || d.stock.nearExpiryUnits > 0) && (
            <div className="drug-flags" style={{ marginTop: 8 }}>
              {d.stock.expiredUnits > 0 && <span className="badge danger">{d.stock.expiredUnits} units expired</span>}
              {d.stock.nearExpiryUnits > 0 && <span className="badge warn">{d.stock.nearExpiryUnits} units expire within 90 days</span>}
              <button className="btn btn-sm" onClick={() => go('stock')}>See stock</button>
            </div>
          )}
        </div>
        <div className="card">
          <h3>Fast moving (30 days)</h3>
          <table className="table">
            <thead><tr><th>Medicine</th><th className="num">Units</th><th className="num">Sold</th></tr></thead>
            <tbody>
              {d.fastMoving.map((f) => <tr key={f.drugName}><td>{f.drugName}</td><td className="num">{f.qty}</td><td className="num mono">{rupees(f.total)}</td></tr>)}
              {d.fastMoving.length === 0 && <tr><td colSpan={3} className="empty-state">No sales yet.</td></tr>}
            </tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>Last seven days</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 90 }}>
            {d.lastSevenDays.map((x) => (
              <div key={x.day} style={{ flex: 1, textAlign: 'center' }} title={`${day(x.day)}: ${rupees(x.total)}`}>
                <div style={{ background: 'var(--brand)', height: Math.max(3, (x.total / peak) * 70), borderRadius: 3 }} />
                <div className="rx-small">{day(x.day).slice(0, 6)}</div>
              </div>
            ))}
            {d.lastSevenDays.length === 0 && <div className="empty-state">No sales this week.</div>}
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Dispense queue ------------------------------------------------------------------------------------------------------------------

function QueueTab() {
  const [rows, setRows] = useState<pharmacy.QueueRow[]>([]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { pharmacy.fetchQueue().then(setRows, reportError); }, []);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);

  const give = async (row: pharmacy.QueueRow) => {
    const n = Math.floor(Number(qty[row.id] ?? row.suggestedQty ?? 1));
    if (!(n >= 1)) return reportError(new Error('Enter how many units to hand over'));
    setBusy(row.id);
    try {
      const done = await pharmacy.dispense(row.id, n);
      const billed = done.billFinalised
        ? `. The visit's bill ${done.billNo} was already finalised: charge this medicine separately`
        : done.billNo ? `, added to bill ${done.billNo}` : '';
      useNoticeStore.getState().show(`${n} × ${row.drugName} handed over (${done.invoiceNo})${done.remainingStock !== null ? `, ${done.remainingStock} left` : ''}${billed}`, done.billFinalised ? 'error' : 'info');
      load();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h3>Waiting to be dispensed</h3>
      <div className="card-sub">Prescriptions from OPD, emergency and the wards. Handing one over takes the stock (earliest expiry first) and adds it to the patient's bill.</div>
      <table className="table">
        <thead><tr><th>Patient</th><th>Medicine</th><th>Prescribed</th><th>Visit</th><th className="num">In stock</th><th className="num">Units to give</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><b>{r.patientName}</b><div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{r.mrn}</div></td>
              <td>{r.drugName}{!r.listed && <div><Badge tone="warn">Not in the stock list</Badge></div>}</td>
              <td>{r.dose} · {r.frequency} · {r.duration}{r.scheduledTimes && <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>Ward schedule: {r.scheduledTimes.join(', ')}</div>}</td>
              <td><Badge tone="neutral">{r.encounterType}</Badge></td>
              <td className="num mono">{r.listed ? `${r.stock} ${r.unit}` : '—'}</td>
              <td className="num"><input type="number" min={1} style={{ width: 80, textAlign: 'right' }} value={qty[r.id] ?? String(r.suggestedQty ?? 1)} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />{r.suggestedQty && <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>for the course</div>}</td>
              <td><button className="btn btn-sm btn-primary" disabled={busy === r.id || (r.listed && (r.stock ?? 0) < 1)} onClick={() => give(r)}>{busy === r.id ? '…' : 'Dispense'}</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="empty-state">Nothing is waiting.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Sales ---------------------------------------------------------------------------------------------------------------------------------

function SalesTab() {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [search, setSearch] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof pharmacy.fetchSales>> | null>(null);
  const [open, setOpen] = useState<pharmacy.SaleDetail | null>(null);
  const [cancelling, setCancelling] = useState<pharmacy.SaleDetail | null>(null);
  const load = useCallback(() => { pharmacy.fetchSales({ from, to, search: search.trim() || undefined }).then(setData, reportError); }, [from, to, search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const view = async (id: string) => { try { setOpen(await pharmacy.fetchSale(id)); } catch (err) { reportError(err); } };

  return (
    <div className="card">
      <h3>Sales and invoices</h3>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}><label>Search</label><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice no., customer, patient or MRN" /></div>
      </div>
      {data && <div className="ai-hint" style={{ marginBottom: 8 }}>{data.totals.count} invoice{data.totals.count === 1 ? '' : 's'} · {rupees(data.totals.total)} (taxable {rupees(data.totals.taxable)}, GST {rupees(data.totals.tax)}). Cancelled ones are not counted.</div>}
      <table className="table">
        <thead><tr><th>Invoice</th><th>When</th><th>Customer / patient</th><th>Kind</th><th className="num">Total</th><th>Paid by</th><th></th></tr></thead>
        <tbody>
          {data?.sales.map((s) => (
            <tr key={s.id} style={s.status === 'cancelled' ? { opacity: 0.5 } : undefined}>
              <td className="mono">{s.invoiceNo}{s.status === 'cancelled' && <> <Badge tone="danger">Cancelled</Badge></>}</td><td>{when(s.soldAt)}</td>
              <td>{s.patientName ?? s.customerName ?? 'Walk-in'}</td><td>{s.kind === 'counter' ? 'Counter sale' : 'Dispensed for a visit'}</td>
              <td className="num mono">{rupees(s.total)}</td><td>{s.paymentMode ?? '—'}</td>
              <td><button className="btn btn-sm" onClick={() => view(s.id)}>Open</button></td>
            </tr>
          ))}
          {data && data.sales.length === 0 && <tr><td colSpan={7} className="empty-state">No sales in this period.</td></tr>}
        </tbody>
      </table>
      {open && <PharmacyInvoicePrint sale={open} onClose={() => setOpen(null)} onCancel={open.kind === 'counter' ? () => { setCancelling(open); setOpen(null); } : undefined} />}
      {cancelling && <CancelSaleDialog sale={cancelling} onClose={() => setCancelling(null)} onDone={(s) => { setCancelling(null); setOpen(s); load(); }} />}
    </div>
  );
}

// ---- GST and profit ---------------------------------------------------------------------------------------------------------------

function download(name: string, rows: (string | number)[][]) {
  const text = rows.map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function ReportsTab() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayIst());
  const [gst, setGst] = useState<pharmacy.Gstr1 | null>(null);
  const [pnl, setPnl] = useState<pharmacy.ProfitLoss | null>(null);
  const [view, setView] = useState<'gst' | 'pnl'>('gst');
  const load = useCallback(() => {
    if (to < from) return;
    pharmacy.fetchGstr1(from, to).then(setGst, reportError);
    pharmacy.fetchProfitLoss(from, to).then(setPnl, reportError);
  }, [from, to]);
  useEffect(load, [load]);

  const exportGst = () => {
    if (!gst) return;
    download(`gstr1-pharmacy-${from}-to-${to}.csv`, [
      ['Supplies to consumers by rate (table 7)'], ['GST rate %', 'Taxable value', 'CGST', 'SGST', 'Total'],
      ...gst.b2cByRate.map((r) => [r.gstPct, r.taxable, r.cgst, r.sgst, r.total]), [],
      ['HSN summary (table 12)'], ['HSN', 'Description', 'UQC', 'Quantity', 'GST rate %', 'Taxable value', 'CGST', 'SGST', 'Total'],
      ...gst.hsn.map((h) => [h.hsnCode, h.description, h.uqc, h.qty, h.gstPct, h.taxable, h.cgst, h.sgst, h.total]), [],
      ['Credit notes (invoices of an earlier period cancelled in this one)'], ['Invoice', 'Invoiced', 'Cancelled', 'Taxable', 'Tax', 'Total'],
      ...gst.creditNotes.map((c) => [c.invoiceNo, c.soldAt, c.cancelledAt, c.taxable, c.tax, c.total]), [],
      ['Documents issued (table 13)'], ['From', 'To', 'Issued', 'Cancelled'], [gst.documents.first ?? '', gst.documents.last ?? '', gst.documents.issued, gst.documents.cancelled],
    ]);
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button className={`btn btn-sm${view === 'gst' ? ' btn-primary' : ''}`} onClick={() => setView('gst')}>GST return figures</button>
          <button className={`btn btn-sm${view === 'pnl' ? ' btn-primary' : ''}`} onClick={() => setView('pnl')}>Profit & loss</button>
        </div>
      </div>

      {view === 'gst' && gst && (
        <div className="card">
          <div className="flex-between"><div><h3>GSTR-1 figures, {day(from)} to {day(to)}</h3><div className="card-sub">Pharmacy sales, treated as within the state (tax split equally into CGST and SGST). These are preparation figures: have your accountant check them before filing.</div></div><button className="btn btn-sm btn-primary" onClick={exportGst}>Download CSV</button></div>
          <h4 style={{ margin: '8px 0 4px' }}>Supplies to consumers, by tax rate</h4>
          <table className="table">
            <thead><tr><th>GST rate</th><th className="num">Taxable value</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Total</th></tr></thead>
            <tbody>
              {gst.b2cByRate.map((r) => <tr key={r.gstPct}><td>{r.gstPct}%</td><td className="num mono">{rupees(r.taxable)}</td><td className="num mono">{rupees(r.cgst)}</td><td className="num mono">{rupees(r.sgst)}</td><td className="num mono">{rupees(r.total)}</td></tr>)}
              <tr><td><b>Total</b></td><td className="num mono"><b>{rupees(gst.totals.taxable)}</b></td><td className="num mono"><b>{rupees(gst.totals.cgst)}</b></td><td className="num mono"><b>{rupees(gst.totals.sgst)}</b></td><td className="num mono"><b>{rupees(gst.totals.total)}</b></td></tr>
            </tbody>
          </table>
          <h4 style={{ margin: '12px 0 4px' }}>HSN summary</h4>
          <table className="table">
            <thead><tr><th>HSN</th><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
            <tbody>{gst.hsn.map((h) => <tr key={`${h.hsnCode}-${h.gstPct}`}><td className="mono">{h.hsnCode}</td><td>{h.description}</td><td className="num">{h.qty}</td><td className="num">{h.gstPct}%</td><td className="num mono">{rupees(h.taxable)}</td><td className="num mono">{rupees(h.cgst)}</td><td className="num mono">{rupees(h.sgst)}</td></tr>)}</tbody>
          </table>
          <div className="ai-hint" style={{ marginTop: 10 }}>
            Documents issued: {gst.documents.issued}{gst.documents.first ? ` (${gst.documents.first} to ${gst.documents.last})` : ''}, of which {gst.documents.cancelled} cancelled · Credit notes: {gst.creditNotes.length} ·
            Tax paid on purchases in the period: {rupees(gst.totals.inputTax)}
          </div>
        </div>
      )}

      {view === 'pnl' && pnl && (
        <div className="card">
          <h3>Profit & loss, {day(from)} to {day(to)}</h3>
          <div className="kpi-row">
            <div className="kpi"><div className="label">Sales (before GST)</div><div className="value">{rupees(pnl.revenue)}</div><div className="rx-small">counter {rupees(pnl.revenueByKind.counter)} · patients {rupees(pnl.revenueByKind.encounter)}</div></div>
            <div className="kpi"><div className="label">Cost of what was sold</div><div className="value">{rupees(pnl.costOfGoodsSold)}</div></div>
            <div className="kpi"><div className="label">Gross profit</div><div className="value">{rupees(pnl.grossProfit)}</div><div className="rx-small">{pnl.marginPct !== null ? `${pnl.marginPct}% margin` : ''}</div></div>
            <div className="kpi"><div className="label">Bought in the period</div><div className="value">{rupees(pnl.purchases.taxable)}</div><div className="rx-small">+ GST {rupees(pnl.purchases.gst)}</div></div>
          </div>
          {pnl.revenueWithoutKnownCost > 0 && <div className="drug-flags" style={{ marginBottom: 8 }}><span className="badge warn">{rupees(pnl.revenueWithoutKnownCost)} of sales are of stock with no purchase price, so they are left out of the profit.</span></div>}
          <table className="table">
            <thead><tr><th>Medicine</th><th className="num">Units</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th></tr></thead>
            <tbody>{pnl.byItem.map((i) => <tr key={i.drugName}><td>{i.drugName}</td><td className="num">{i.qty}</td><td className="num mono">{rupees(i.revenue)}</td><td className="num mono">{rupees(i.cost)}</td><td className="num mono">{rupees(i.profit)}</td></tr>)}
              {pnl.byItem.length === 0 && <tr><td colSpan={5} className="empty-state">No sales in this period.</td></tr>}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

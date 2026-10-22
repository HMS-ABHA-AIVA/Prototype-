import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as pharmacy from '../../api/pharmacy';
import { modeLabel } from '../../api/opdBilling';
import { PrintDialog, SheetFooter, SheetHeader, SignatureRow, day, when } from '../../components/print/PrintSheet';
import { useSettings } from '../../components/shared/useSettings';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { rupeesInWords } from '../../utils/inWords';
import { PaymentFields, emptyPayment, paymentProblem, rupees, toPaymentDetails, type PaymentState } from '../opdbilling/BillingFields';

/** A pharmacy tax invoice: GSTIN and drug licence, each line with batch, expiry and MRP, the GST by rate (CGST + SGST) and the amount in words. */
export function PharmacyInvoicePrint({ sale, onClose, onCancel }: { sale: pharmacy.SaleDetail; onClose: () => void; onCancel?: () => void }) {
  const settings = useSettings();
  const cancelled = sale.status === 'cancelled';
  return (
    <PrintDialog title={`Pharmacy invoice ${sale.invoiceNo}`} onClose={onClose} width={860} actions={onCancel && !cancelled ? <button className="btn btn-sm btn-danger" onClick={onCancel}>Cancel this sale</button> : undefined}>
      <div className="rx-sheet invoice-sheet">
        {cancelled && <div className="invoice-stamp">CANCELLED</div>}
        <SheetHeader title={sale.kind === 'counter' ? 'PHARMACY TAX INVOICE' : 'PHARMACY ISSUE (billed on the visit)'} subtitle={settings?.drugLicenseNo ? `Drug licence no. ${settings.drugLicenseNo}` : undefined} />
        <div className="rx-meta">
          <div>
            <div><b>{sale.patientName ?? sale.customerName ?? 'Walk-in customer'}</b></div>
            {sale.mrn && <div className="rx-small">MRN {sale.mrn}</div>}
            {sale.customerPhone && <div className="rx-small">{sale.customerPhone}</div>}
          </div>
          <div className="rx-right">
            <div>Invoice: <b className="mono">{sale.invoiceNo}</b></div>
            <div className="rx-small">{when(sale.soldAt)}</div>
          </div>
        </div>
        <table className="rx-table">
          <thead><tr><th>#</th><th>Medicine</th><th>Batch</th><th>Expiry</th><th>HSN</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>MRP</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {sale.items.map((i, n) => (
              <tr key={i.id}>
                <td>{n + 1}</td><td>{i.drugName}</td><td>{i.batchNo ?? '—'}</td><td>{i.expiry ? day(i.expiry) : '—'}</td><td>{i.hsnCode}</td>
                <td style={{ textAlign: 'right' }}>{i.qty}</td><td style={{ textAlign: 'right' }} className="mono">{rupees(i.mrp)}</td>
                <td style={{ textAlign: 'right' }}>{i.gstPct}%</td><td style={{ textAlign: 'right' }} className="mono">{rupees(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="rx-table" style={{ maxWidth: 520, marginLeft: 'auto' }}>
          <thead><tr><th>GST</th><th style={{ textAlign: 'right' }}>Taxable</th><th style={{ textAlign: 'right' }}>CGST</th><th style={{ textAlign: 'right' }}>SGST</th></tr></thead>
          <tbody>{sale.taxSummary.map((t) => <tr key={t.gstPct}><td>{t.gstPct}%</td><td style={{ textAlign: 'right' }} className="mono">{rupees(t.taxable)}</td><td style={{ textAlign: 'right' }} className="mono">{rupees(t.cgst)}</td><td style={{ textAlign: 'right' }} className="mono">{rupees(t.sgst)}</td></tr>)}</tbody>
        </table>
        <table className="invoice-totals">
          <tbody>
            {sale.discountPct > 0 && <tr><td>Discount</td><td className="mono">{sale.discountPct}% off the MRP</td></tr>}
            <tr><td>Taxable value</td><td className="mono">{rupees(sale.taxable)}</td></tr>
            <tr><td>GST (included in the MRP)</td><td className="mono">{rupees(sale.tax)}</td></tr>
            <tr className="invoice-net"><td>Total</td><td className="mono">{rupees(sale.total)}</td></tr>
          </tbody>
        </table>
        <div className="rx-small" style={{ marginTop: 6 }}>{rupeesInWords(sale.total)}</div>
        {sale.paymentMode && <div className="rx-line rx-small">Paid by <b>{modeLabel(sale.paymentMode)}</b>{sale.paymentReference ? ` · ref ${sale.paymentReference}` : ''}{sale.amountReceived != null ? ` · cash received ${rupees(sale.amountReceived)}${sale.change ? `, change ${rupees(sale.change)}` : ''}` : ''}</div>}
        {cancelled && <div className="invoice-refund"><b>Cancelled</b> on {when(sale.cancelledAt)} by {sale.cancelledBy}: {sale.cancelReason}. The stock was returned.</div>}
        <SignatureRow labels={['Customer', `Pharmacist (${sale.soldBy})`]} />
        <SheetFooter extra="Medicines are returnable only as the pharmacy's policy allows. MRP is inclusive of all taxes." />
      </div>
    </PrintDialog>
  );
}

interface CartLine { item: pharmacy.DrugItem; qty: number }

/** Sells medicines over the counter: pick items, take the payment, and print the GST invoice. Stock comes off the batches that expire first. */
export function CounterSaleTab() {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<pharmacy.DrugItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [discount, setDiscount] = useState('0');
  const [payment, setPayment] = useState<PaymentState>(emptyPayment);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<pharmacy.SaleDetail | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => { pharmacy.fetchItems(search).then((r) => setResults(r.slice(0, 30)), reportError); }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const pct = Math.min(100, Math.max(0, Number(discount) || 0));
  const total = Math.round(cart.reduce((s, l) => s + l.qty * l.item.mrp * (1 - pct / 100), 0) * 100) / 100;
  const problem = cart.length === 0 ? 'Add a medicine' : cart.some((l) => !(l.qty >= 1)) ? 'Check the quantities' : cart.some((l) => l.qty > l.item.stock) ? 'Not enough stock for one of the items' : paymentProblem(payment, total);

  const add = (item: pharmacy.DrugItem) => {
    setCart((c) => (c.some((l) => l.item.id === item.id) ? c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { item, qty: 1 }]));
    setSearch('');
    searchBox.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    try {
      const sale = await pharmacy.createSale({
        customerName: customer.trim() || undefined, customerPhone: phone.trim() || undefined, discountPct: pct,
        items: cart.map((l) => ({ drugId: l.item.id, qty: l.qty })),
        payment: toPaymentDetails(payment) as pharmacy.CounterSaleInput['payment'],
      });
      setDone(sale);
      setCart([]); setCustomer(''); setPhone(''); setDiscount('0'); setPayment(emptyPayment);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>Counter sale</h3>
      <div className="card-sub">For walk-in customers and patients buying medicines. Prices are the MRP (GST included); stock comes off the batch that expires first.</div>
      <div className="two-col">
        <div className="field"><label>Customer name (optional)</label><input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} /></div>
        <div className="field"><label>Phone (optional)</label><input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} /></div>
      </div>
      <div className="field">
        <label>Add a medicine</label>
        <input ref={searchBox} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type the medicine name" autoFocus />
      </div>
      {search && (
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10 }}>
          {results.map((r) => (
            <div key={r.id} onClick={() => r.stock > 0 && add(r)} style={{ padding: '7px 10px', cursor: r.stock > 0 ? 'pointer' : 'not-allowed', opacity: r.stock > 0 ? 1 : 0.5, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
              <span>{r.name} <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{r.batch ? `batch ${r.batch}` : ''}{r.expiry ? ` · exp ${day(r.expiry)}` : ''}</span></span>
              <span className="mono">{r.stock > 0 ? `${r.stock} ${r.unit} · ${rupees(r.mrp)}` : 'out of stock'}</span>
            </div>
          ))}
          {results.length === 0 && <div className="empty-state">No medicine matches.</div>}
        </div>
      )}
      <table className="table">
        <thead><tr><th>Medicine</th><th className="num">In stock</th><th className="num">MRP</th><th className="num">Qty</th><th className="num">Amount</th><th></th></tr></thead>
        <tbody>
          {cart.map((l) => (
            <tr key={l.item.id}>
              <td>{l.item.name}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>GST {l.item.gstPct}%</div></td>
              <td className="num">{l.item.stock} {l.item.unit}</td><td className="num mono">{rupees(l.item.mrp)}</td>
              <td className="num"><input type="number" min={1} max={l.item.stock} style={{ width: 80, textAlign: 'right' }} value={l.qty} onChange={(e) => setCart(cart.map((x) => (x.item.id === l.item.id ? { ...x, qty: Math.floor(Number(e.target.value)) } : x)))} /></td>
              <td className="num mono">{rupees(Math.round(l.qty * l.item.mrp * (1 - pct / 100) * 100) / 100)}</td>
              <td><button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${l.item.name}`} onClick={() => setCart(cart.filter((x) => x.item.id !== l.item.id))}>✕</button></td>
            </tr>
          ))}
          {cart.length === 0 && <tr><td colSpan={6} className="empty-state">The bill is empty.</td></tr>}
        </tbody>
      </table>
      <div className="two-col" style={{ marginTop: 10 }}>
        <div className="field" style={{ maxWidth: 200 }}><label>Discount on MRP (%)</label><input type="number" min={0} max={100} value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
        <div style={{ textAlign: 'right' }}><div className="rx-small">Total to pay</div><div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{rupees(total)}</div></div>
      </div>
      <PaymentFields value={payment} onChange={setPayment} total={total} />
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Saving…' : `Complete sale · ${rupees(total)}`}</button>
      </div>
      {done && <PharmacyInvoicePrint sale={done} onClose={() => setDone(null)} />}
    </form>
  );
}

/** Asks for the reason, then cancels a counter sale (the stock goes back to its batches). */
export function CancelSaleDialog({ sale, onClose, onDone }: { sale: pharmacy.SaleDetail; onClose: () => void; onDone: (sale: pharmacy.SaleDetail) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const cancelled = await pharmacy.cancelSale(sale.id, reason.trim());
      useNoticeStore.getState().show(`${sale.invoiceNo} cancelled, stock returned`, 'info');
      onDone(cancelled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the sale');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Cancel ${sale.invoiceNo}`} onClose={onClose} width={460}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>The medicines go back into the batches they came from, and the invoice stays on record as cancelled ({rupees(sale.total)}). Give the money back to the customer yourself.</p>
        <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={busy || reason.trim().length < 3}>{busy ? 'Cancelling…' : 'Cancel the sale'}</button>
        </div>
      </form>
    </Modal>
  );
}

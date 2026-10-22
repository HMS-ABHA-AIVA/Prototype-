import { useCallback, useEffect, useMemo, useState } from 'react';
import * as lab from '../../api/lab';
import { fetchInvestigations, type Investigation } from '../../api/masters';
import { fetchPanels, modeLabel, type Panel } from '../../api/opdBilling';
import { PrintDialog, SheetFooter, SheetHeader, SignatureRow, ageOf, genderWord, when } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { rupeesInWords } from '../../utils/inWords';
import { ReasonDialog } from '../ipdbilling/IpdBillDialogs';
import { PaymentFields, emptyPayment, paymentProblem, rupees, toPaymentDetails, type PaymentState } from '../opdbilling/BillingFields';

const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** The invoice for tests taken at the lab desk: each test with its rate, the discount and GST, how it was paid. Also the receipt. */
export function LabInvoicePrint({ invoice, onClose, onCancel }: { invoice: lab.LabInvoice; onClose: () => void; onCancel?: () => void }) {
  const cancelled = invoice.status === 'cancelled';
  return (
    <PrintDialog title={`Lab invoice ${invoice.invoiceNo}`} onClose={onClose} width={760} actions={onCancel && !cancelled ? <button className="btn btn-sm btn-danger" onClick={onCancel}>Cancel this invoice</button> : undefined}>
      <div className="rx-sheet invoice-sheet">
        {cancelled && <div className="invoice-stamp">CANCELLED</div>}
        <SheetHeader title="LABORATORY & RADIOLOGY INVOICE" />
        <div className="rx-meta">
          <div>
            <div><b>{invoice.patientName}</b> · {[ageOf(invoice.yearOfBirth), genderWord(invoice.gender)].filter(Boolean).join(' · ')}</div>
            <div className="rx-small">MRN {invoice.mrn}{invoice.phone ? ` · ${invoice.phone}` : ''}</div>
            {invoice.referredBy && <div className="rx-small">Referred by {invoice.referredBy}</div>}
            {invoice.panelName && <div className="rx-small">Billing category: {invoice.panelName}{invoice.beneficiaryId ? ` · ${invoice.beneficiaryId}` : ''}</div>}
          </div>
          <div className="rx-right">
            <div>Invoice: <b className="mono">{invoice.invoiceNo}</b></div>
            <div className="rx-small">{when(invoice.createdAt)}</div>
          </div>
        </div>
        <table className="rx-table">
          <thead><tr><th>#</th><th>Test</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {invoice.items.map((i, n) => (
              <tr key={i.id}>
                <td>{n + 1}</td><td>{i.name}{i.standardRate !== i.rate && <span className="rx-small"> (standard {rupees(i.standardRate)})</span>}</td>
                <td style={{ textAlign: 'right' }} className="mono">{rupees(i.rate)}</td><td style={{ textAlign: 'right' }}>{i.gstPct}%</td><td style={{ textAlign: 'right' }} className="mono">{rupees(i.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="invoice-totals">
          <tbody>
            <tr><td>Sub-total</td><td className="mono">{rupees(invoice.subtotal)}</td></tr>
            {invoice.discount > 0 && <tr><td>Discount ({invoice.discountPct}%)</td><td className="mono">− {rupees(invoice.discount)}</td></tr>}
            {invoice.gstTotal > 0 && <tr><td>GST</td><td className="mono">{rupees(invoice.gstTotal)}</td></tr>}
            <tr className="invoice-net"><td>Total</td><td className="mono">{rupees(invoice.total)}</td></tr>
          </tbody>
        </table>
        <div className="rx-small" style={{ marginTop: 6 }}>{rupeesInWords(invoice.total)}</div>
        <div className="rx-line rx-small">Paid by <b>{modeLabel(invoice.paymentMode)}</b>{invoice.paymentReference ? ` · ref ${invoice.paymentReference}` : ''}{invoice.amountReceived != null ? ` · cash received ${rupees(invoice.amountReceived)}${invoice.change ? `, change ${rupees(invoice.change)}` : ''}` : ''}</div>
        {cancelled && <div className="invoice-refund"><b>Cancelled</b> on {when(invoice.cancelledAt)} by {invoice.cancelledBy}: {invoice.cancelReason}. Give the money back to the patient.</div>}
        <SignatureRow labels={['Patient', `Received by (${invoice.createdBy})`]} />
        <SheetFooter extra="Reports are issued after the tests are done; please bring this invoice or the sample number." />
      </div>
    </PrintDialog>
  );
}

/** Raises an invoice for tests a registered patient wants done now: pick the patient and tests, see the exact amount, take the payment. */
export function NewTestsTab({ onDone }: { onDone: () => void }) {
  const { patients } = useHospitalStore();
  useRefresh(['patients']);
  const [find, setFind] = useState('');
  const [patientId, setPatientId] = useState<string | null>(null);
  const [tests, setTests] = useState<Investigation[]>([]);
  const [testSearch, setTestSearch] = useState('');
  const [picked, setPicked] = useState<Investigation[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelId, setPanelId] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [discount, setDiscount] = useState('0');
  const [referredBy, setReferredBy] = useState('');
  const [payment, setPayment] = useState<PaymentState>(emptyPayment);
  const [quote, setQuote] = useState<lab.Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<lab.LabInvoice | null>(null);

  useEffect(() => {
    fetchInvestigations({}).then(setTests, reportError);
    fetchPanels().then(setPanels, () => undefined);
  }, []);

  const patient = patients.find((p) => p.id === patientId) ?? null;
  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return patients.filter((p) => p.name.toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q) || p.phone.includes(q)).slice(0, 8);
  }, [find, patients]);
  const panel = panels.find((p) => p.id === panelId) ?? null;
  const pct = Number(discount);
  const pickedIds = picked.map((t) => t.id).join(',');

  // The exact amount, worked out by the server (panel rates, discount and GST), whenever the choices change.
  useEffect(() => {
    // Nothing to price yet, or a panel whose card number has not been typed (asking the server would only scold).
    if (picked.length === 0 || (panel?.requiresBeneficiaryId && !beneficiary.trim())) { setQuote(null); setQuoteError(null); return; }
    let current = true;
    const handle = setTimeout(() => {
      lab.quoteInvoice({
        tests: picked.map((t) => ({ investigationId: t.id })), ...(panelId ? { panelId } : {}), ...(beneficiary.trim() ? { beneficiaryId: beneficiary.trim() } : {}),
        discountPct: Number.isFinite(pct) ? pct : 0,
      }).then((q) => { if (current) { setQuote(q); setQuoteError(null); } }, (err) => { if (current) { setQuote(null); setQuoteError(err instanceof Error ? err.message : 'Could not work out the amount'); } });
    }, 250);
    return () => { current = false; clearTimeout(handle); };
  }, [pickedIds, panelId, beneficiary, pct]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsCard = !!panel?.requiresBeneficiaryId && !beneficiary.trim();

  const total = quote?.total ?? 0;
  const problem = !patient ? 'Choose the patient' : picked.length === 0 ? 'Add at least one test' : !(pct >= 0 && pct <= 100) ? 'The discount must be between 0 and 100' : needsCard ? `Enter the ${panel?.code} beneficiary / card number` : quoteError ?? (quote ? paymentProblem(payment, total) : 'Working out the amount…');
  const shown = tests.filter((t) => !picked.some((p) => p.id === t.id) && (testSearch.trim().length === 0 ? false : t.name.toLowerCase().includes(testSearch.trim().toLowerCase()) || t.code.toLowerCase().startsWith(testSearch.trim().toLowerCase()))).slice(0, 10);

  const submit = async () => {
    if (!patient || busy || problem) return;
    setBusy(true);
    try {
      const invoice = await lab.createInvoice({
        patientId: patient.id, tests: picked.map((t) => ({ investigationId: t.id })), ...(panelId ? { panelId } : {}), ...(beneficiary.trim() ? { beneficiaryId: beneficiary.trim() } : {}),
        discountPct: pct, ...(referredBy.trim() ? { referredBy: referredBy.trim() } : {}), payment: toPaymentDetails(payment) as lab.NewInvoice['payment'],
      });
      setDone(invoice);
      setPicked([]); setPatientId(null); setFind(''); setPanelId(''); setBeneficiary(''); setDiscount('0'); setReferredBy(''); setPayment(emptyPayment);
      useNoticeStore.getState().show(`${invoice.invoiceNo} raised: the tests are on the worklist`, 'info');
      onDone();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Tests for a registered patient</h3>
      <div className="card-sub">For a patient who has come for tests without a doctor's visit here, or with a referral from outside. Tests ordered during a visit are billed with that visit instead.</div>

      <div className="field">
        <label>Patient *</label>
        {patient ? (
          <div className="row"><b>{patient.name}</b><span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>MRN {patient.mrn} · {patient.age}{patient.gender} · {patient.phone}</span><button className="btn btn-ghost btn-sm" onClick={() => setPatientId(null)}>Change</button></div>
        ) : (
          <>
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Name, MRN or phone number" autoFocus />
            {matches.map((p) => <div key={p.id} onClick={() => { setPatientId(p.id); setFind(''); }} style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}><b>{p.name}</b> <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>MRN {p.mrn} · {p.age}{p.gender} · {p.phone}</span></div>)}
            {find.trim().length >= 2 && matches.length === 0 && <div className="ai-hint">No registered patient matches. Registration is done at the front office.</div>}
          </>
        )}
      </div>

      <div className="field">
        <label>Add a test</label>
        <input value={testSearch} onChange={(e) => setTestSearch(e.target.value)} placeholder="Type the test name or code" />
        {shown.map((t) => (
          <div key={t.id} onClick={() => { setPicked([...picked, t]); setTestSearch(''); }} style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
            <span>{t.name} <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{t.code} · {t.kind}{t.section ? ` · ${t.section}` : ''}</span></span><span className="mono">{rupees(t.price)}</span>
          </div>
        ))}
      </div>
      <table className="table">
        <thead><tr><th>Test</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Amount</th><th></th></tr></thead>
        <tbody>
          {picked.map((t) => {
            const line = quote?.lines.find((l) => l.investigationId === t.id);
            return (
              <tr key={t.id}>
                <td>{t.name}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{t.kind}{t.sample ? ` · ${t.sample}` : ''}{t.tatHours != null ? ` · report in ${t.tatHours} h` : ''}</div></td>
                <td className="num mono">{rupees(line?.rate ?? t.price)}{line && line.rate !== line.standardRate && <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>standard {rupees(line.standardRate)}</div>}</td>
                <td className="num">{t.gstPct}%</td>
                <td className="num mono">{line ? rupees(line.amount) : '…'}</td>
                <td><button className="btn btn-ghost btn-sm" aria-label={`Remove ${t.name}`} onClick={() => setPicked(picked.filter((p) => p.id !== t.id))}>✕</button></td>
              </tr>
            );
          })}
          {picked.length === 0 && <tr><td colSpan={5} className="empty-state">No tests added yet.</td></tr>}
        </tbody>
      </table>

      <div className="two-col" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Billing category</label>
          <select value={panelId} onChange={(e) => { setPanelId(e.target.value); setBeneficiary(''); }}>
            <option value="">Standard (self-pay)</option>
            {panels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {panel?.requiresBeneficiaryId ? (
          <div className="field"><label>{panel.code} beneficiary / card number *</label><input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} maxLength={60} /></div>
        ) : (
          <div className="field"><label>Referred by (optional)</label><input value={referredBy} onChange={(e) => setReferredBy(e.target.value)} maxLength={120} placeholder="Doctor or hospital" /></div>
        )}
      </div>
      <div className="two-col">
        <div className="field" style={{ maxWidth: 200 }}><label>Discount (%)</label><input type="number" min={0} max={100} value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
        <div style={{ textAlign: 'right' }}>
          {quote && quote.discount > 0 && <div className="rx-small">Discount − {rupees(quote.discount)}</div>}
          {quote && quote.gstTotal > 0 && <div className="rx-small">GST {rupees(quote.gstTotal)}</div>}
          <div className="rx-small">Total to pay</div><div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{rupees(total)}</div>
        </div>
      </div>
      {quoteError && <div className="login-error" role="alert">{quoteError}</div>}
      <PaymentFields value={payment} onChange={setPayment} total={total} />
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={submit}>{busy ? 'Saving…' : `Take payment · ${rupees(total)}`}</button>
      </div>
      {done && <LabInvoicePrint invoice={done} onClose={() => setDone(null)} />}
    </div>
  );
}

/** Invoices raised at the lab desk: find one, reprint it, or (billing counter) cancel it before any work has started. */
export function InvoicesTab({ canCancel }: { canCancel: boolean }) {
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [search, setSearch] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof lab.fetchInvoices>> | null>(null);
  const [open, setOpen] = useState<lab.LabInvoice | null>(null);
  const [cancelling, setCancelling] = useState<lab.LabInvoice | null>(null);
  const load = useCallback(() => { lab.fetchInvoices({ from, to, search }).then(setData, reportError); }, [from, to, search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const view = (id: string) => lab.fetchInvoice(id).then(setOpen, reportError);
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}><label>Search</label><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice no., patient name or MRN" /></div>
      </div>
      <table className="table">
        <thead><tr><th>Invoice</th><th>When</th><th>Patient</th><th className="num">Tests</th><th>Paid by</th><th className="num">Total</th><th></th></tr></thead>
        <tbody>
          {data?.invoices.map((i) => (
            <tr key={i.id}>
              <td className="mono">{i.invoiceNo}</td><td>{when(i.createdAt)}</td><td>{i.patientName}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{i.mrn}</div></td>
              <td className="num">{i.itemCount}</td><td>{modeLabel(i.paymentMode)}</td>
              <td className="num mono">{i.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : rupees(i.total)}</td>
              <td><button className="btn btn-sm" onClick={() => view(i.id)}>Open</button></td>
            </tr>
          ))}
          {data && data.invoices.length === 0 && <tr><td colSpan={7} className="empty-state">No lab invoices in this period.</td></tr>}
        </tbody>
      </table>
      {data && <div className="rx-small" style={{ marginTop: 8, color: 'var(--ink-soft)' }}>{data.totals.count} invoice(s), {rupees(data.totals.total)} collected (cancelled ones left out).</div>}
      {open && <LabInvoicePrint invoice={open} onClose={() => setOpen(null)} {...(canCancel ? { onCancel: () => setCancelling(open) } : {})} />}
      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.invoiceNo}`} prompt="Reason for cancelling *" confirmLabel="Cancel the invoice"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => { const c = await lab.cancelInvoice(cancelling.id, reason); setCancelling(null); setOpen(c); load(); }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiEnabled } from '../../api/client';
import * as ipd from '../../api/ipd';
import { modeLabel } from '../../api/opdBilling';
import { day, when } from '../../components/print/PrintSheet';
import { Badge } from '../../components/ui/Badge';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { useHospitalStore } from '../../store/useHospitalStore';
import { rupees } from '../opdbilling/BillingFields';
import { AddChargeDialog, AdvanceDialog, BillingCategoryDialog, DiscountDialog, ReasonDialog, RefundDialog, SettleDialog } from './IpdBillDialogs';
import { FinalBillPrint, InterimBillPrint, ReceiptPrint } from './prints';

const SOURCE_LABEL: Record<ipd.LineSource, string> = { bed: 'Bed', service: 'Service', custom: 'One-off', investigation: 'Test', medicine: 'Medicine' };

const billBadge = (status: ipd.AdmissionRow['billStatus']) =>
  status === 'paid' ? <Badge tone="ok">Paid</Badge> : status === 'finalized' ? <Badge tone="info">Awaiting payment</Badge> : status === 'draft' ? <Badge tone="warn">Draft bill</Badge> : <Badge tone="neutral">No bill yet</Badge>;

/** Every admission with where its billing stands: who is in the hospital, what advance is held, and discharged patients waiting to settle. */
export function IpdBillingPage() {
  const [rows, setRows] = useState<ipd.AdmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => { ipd.fetchAdmissions().then(setRows, reportError).finally(() => setLoading(false)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!apiEnabled) return <div className="card"><h3>IPD Billing</h3><div className="card-sub">Inpatient billing needs the backend (VITE_API_URL).</div></div>;

  const inHospital = rows.filter((r) => r.status === 'admitted');
  const discharged = rows.filter((r) => r.status !== 'admitted');
  const table = (list: ipd.AdmissionRow[], empty: string) => (
    <table className="table">
      <thead><tr><th>Patient</th><th>Bed</th><th>Doctor</th><th>Admitted</th><th>Category</th><th className="num">Advance held</th><th>Bill</th><th></th></tr></thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.encounterId}>
            <td><b>{r.patientName}</b><div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{r.mrn}</div></td>
            <td>{r.ward ? `${r.ward} ${r.bedNo}` : '—'}</td><td>{r.doctorName ?? '—'}</td><td>{day(r.admittedAt)}</td>
            <td>{r.panelCode ? <Badge tone="brand">{r.panelCode}</Badge> : 'Self-pay'}</td>
            <td className="num mono">{rupees(r.advancesHeld)}</td><td>{billBadge(r.billStatus)}</td>
            <td><Link className="btn btn-sm btn-primary" to={`/ipd-billing/${r.encounterId}`}>Open bill</Link></td>
          </tr>
        ))}
        {list.length === 0 && <tr><td colSpan={8} className="empty-state">{loading ? 'Loading…' : empty}</td></tr>}
      </tbody>
    </table>
  );

  return (
    <>
      <div className="os-head">
        <div>
          <h1>IPD Billing</h1>
          <div className="sub">Running bills, advances and final bills for admitted patients</div>
        </div>
      </div>
      <div className="card"><h3>In hospital now</h3>{table(inHospital, 'No one is admitted right now.')}</div>
      <div className="card"><h3>Discharged, not yet settled</h3>{table(discharged, 'Every discharged patient has settled their bill.')}</div>
    </>
  );
}

/** One admission's bill: charges as they build up, advances and receipts, then the final bill, discount and settlement after discharge. */
export function IpdBillView() {
  const { encounterId = '' } = useParams();
  const navigate = useNavigate();
  const role = useHospitalStore((s) => s.currentRole);
  const counter = role === 'biller' || role === 'admin';
  const mayAdvance = counter || role === 'front_office';
  const mayCharge = counter || role === 'nurse' || role === 'doctor' || role === 'front_office';

  const [running, setRunning] = useState<ipd.RunningBill | null>(null);
  const [finalBill, setFinalBill] = useState<ipd.FinalBill | null>(null);
  const [dialog, setDialog] = useState<'charge' | 'advance' | 'refund' | 'category' | 'discount' | 'settle' | 'interim' | 'final' | null>(null);
  const [voiding, setVoiding] = useState<ipd.BillLine | null>(null);
  const [cancelling, setCancelling] = useState<ipd.Receipt | null>(null);
  const [receipt, setReceipt] = useState<ipd.Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = (message: string) => useNoticeStore.getState().show(message, 'info');

  const apply = useCallback(async (bill: ipd.RunningBill) => {
    setRunning(bill);
    setFinalBill(bill.bill ? await ipd.fetchBill(bill.bill.id) : null);
  }, []);
  const load = useCallback(() => { ipd.fetchRunningBill(encounterId).then(apply, reportError); }, [encounterId, apply]);
  useEffect(load, [load]);

  if (!apiEnabled) return <div className="card">Inpatient billing needs the backend (VITE_API_URL).</div>;
  if (!running) return <div className="empty-state">Loading the bill…</div>;

  const admitted = running.status === 'admitted';
  const discharged = running.status === 'discharged';
  const live = running.lines.filter((l) => !l.voided);
  const openForCharges = admitted || (discharged && counter && (!finalBill || finalBill.status === 'draft'));
  const settled = finalBill?.status === 'paid';

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) notify(done);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const prepare = (discount?: ipd.DiscountInput | null) => run(async () => { await ipd.prepareFinalBill(encounterId, discount); await ipd.fetchRunningBill(encounterId).then(apply); }, 'Final bill prepared');

  return (
    <>
      <div className="os-head">
        <div>
          <h1>{running.patient.name} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 16 }}>· {running.bed ? `${running.bed.ward} ${running.bed.bedNo}` : 'no bed'}</span></h1>
          <div className="sub">
            MRN {running.patient.mrn} · {running.department} · {running.doctorName ?? '—'} · Admitted {day(running.admittedAt)}
            {' '}{admitted ? <Badge tone="ok">In hospital</Badge> : <Badge tone="neutral">Discharged {day(running.dischargedAt)}</Badge>}
          </div>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => navigate(-1)}>← Back</button>
          <Link to={`/ipd/patient/${running.encounterId}`} className="btn btn-sm">Patient file</Link>
          <button className="btn btn-sm" onClick={() => setDialog('interim')}>🖨 Print running bill</button>
        </div>
      </div>

      {running.warnings.map((w) => <div key={w} className="drug-flags" style={{ marginBottom: 8 }}><span className="badge warn">{w}</span></div>)}

      <div className="card">
        <div className="flex-between">
          <div>
            <b>Billed as:</b> {running.panel ? <Badge tone="brand">{running.panel.code}</Badge> : 'Self-pay (standard rates)'}
            {running.panel && running.beneficiaryId && <span className="rx-small"> · card {running.beneficiaryId}</span>}
          </div>
          {(counter || role === 'front_office') && !settled && <button className="btn btn-sm" onClick={() => setDialog('category')}>Change billing category</button>}
        </div>
      </div>

      <div className="card">
        <div className="flex-between">
          <h3>Charges</h3>
          {mayCharge && openForCharges && <button className="btn btn-primary btn-sm" onClick={() => setDialog('charge')}>+ Add a charge</button>}
        </div>
        <table className="table">
          <thead><tr><th>Date</th><th>Description</th><th>Kind</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Amount</th><th></th></tr></thead>
          <tbody>
            {running.lines.map((l, i) => (
              <tr key={l.id ?? `${l.source}-${i}`} style={l.voided ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td>{l.date ? day(l.date) : ''}</td>
                <td>{l.description}{l.voided && <div className="rx-small" style={{ textDecoration: 'none' }}>Voided: {l.voidReason}</div>}</td>
                <td><Badge tone="neutral">{SOURCE_LABEL[l.source]}</Badge></td>
                <td className="num">{l.qty}</td>
                <td className="num mono">{rupees(l.rate)}{l.rate !== l.standardRate && !l.voided && <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>list {rupees(l.standardRate)}</div>}</td>
                <td className="num">{l.gstPct}%</td><td className="num mono">{rupees(l.amount)}</td>
                <td>{counter && l.id && !l.voided && openForCharges && <button className="btn btn-sm btn-ghost" onClick={() => setVoiding(l)}>Void</button>}</td>
              </tr>
            ))}
            {running.lines.length === 0 && <tr><td colSpan={8} className="empty-state">Nothing has been charged yet.</td></tr>}
          </tbody>
        </table>
        <table className="invoice-totals">
          <tbody>
            <tr><td>Sub-total</td><td className="mono">{rupees(running.subtotal)}</td></tr>
            <tr><td>GST</td><td className="mono">{rupees(running.gstTotal)}</td></tr>
            <tr className="invoice-net"><td>Total so far</td><td className="mono">{rupees(running.total)}</td></tr>
            <tr><td>Advances held</td><td className="mono">− {rupees(running.advancesHeld)}</td></tr>
            <tr><td><b>{running.balance >= 0 ? 'Balance' : 'Refund due'}</b></td><td className="mono"><b>{rupees(Math.abs(running.balance))}</b></td></tr>
          </tbody>
        </table>
        {live.length > 0 && !admitted && !finalBill && <div className="ai-hint">Charges are complete when the final bill is prepared below.</div>}
      </div>

      <div className="card">
        <div className="flex-between">
          <h3>Advances & receipts</h3>
          <div className="row">
            {counter && running.advancesHeld > 0 && admitted && <button className="btn btn-sm" onClick={() => setDialog('refund')}>Refund part</button>}
            {mayAdvance && admitted && <button className="btn btn-primary btn-sm" onClick={() => setDialog('advance')}>+ Take an advance</button>}
          </div>
        </div>
        <table className="table">
          <thead><tr><th>Receipt</th><th>Kind</th><th>When</th><th>Mode</th><th className="num">Amount</th><th>By</th><th></th></tr></thead>
          <tbody>
            {running.payments.map((p) => (
              <tr key={p.id} style={p.cancelled ? { opacity: 0.5 } : undefined}>
                <td className="mono">{p.receiptNo}</td>
                <td>{p.kind === 'advance' ? 'Advance' : p.kind === 'refund' ? 'Refund' : 'Settlement'}{p.cancelled && <> <Badge tone="danger">Cancelled</Badge></>}</td>
                <td>{when(p.at)}</td><td>{modeLabel(p.mode)}{p.reference ? ` · ${p.reference}` : ''}</td>
                <td className="num mono">{p.kind === 'refund' ? '− ' : ''}{rupees(p.amount)}</td><td>{p.receivedBy}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm" onClick={() => setReceipt(p)}>🖨</button>
                    {counter && p.kind === 'advance' && !p.cancelled && !settled && <button className="btn btn-sm btn-ghost" onClick={() => setCancelling(p)}>Cancel</button>}
                  </div>
                </td>
              </tr>
            ))}
            {running.payments.length === 0 && <tr><td colSpan={7} className="empty-state">No advance has been taken.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Final bill</h3>
        {admitted && <div className="card-sub">The final bill is prepared once the patient is discharged. Until then the running bill above shows the cost so far.</div>}
        {!admitted && !finalBill && (
          counter
            ? <div><div className="card-sub">The patient has been discharged. Check the charges above, then prepare the final bill.</div><button className="btn btn-primary" disabled={busy} onClick={() => prepare()}>Prepare final bill</button></div>
            : <div className="card-sub">Waiting for the billing counter to prepare the final bill.</div>
        )}
        {finalBill && (
          <>
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <div><span className="mono"><b>{finalBill.billNo}</b></span>{' '}{finalBill.status === 'draft' ? <Badge tone="warn">Draft</Badge> : finalBill.status === 'finalized' ? <Badge tone="info">Finalized · awaiting payment</Badge> : <Badge tone="ok">Paid · {modeLabel(finalBill.paymentMode ?? 'cash')}</Badge>}</div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => setDialog('final')}>🖨 Print bill</button>
                {counter && finalBill.status === 'draft' && (
                  <>
                    <button className="btn btn-sm" disabled={busy} onClick={() => prepare()}>Refresh from charges</button>
                    <button className="btn btn-sm" onClick={() => setDialog('discount')}>{finalBill.discountType ? 'Change discount' : 'Give a discount'}</button>
                  </>
                )}
              </div>
            </div>
            {finalBill.discountType && <div className="ai-hint" style={{ marginBottom: 6 }}>Discount {finalBill.discountType === 'percent' ? `${finalBill.discountValue}%` : rupees(finalBill.discountValue ?? 0)} ({rupees(finalBill.discountAmount)}): {finalBill.discountReason}</div>}
            <table className="invoice-totals" style={{ marginLeft: 0 }}>
              <tbody>
                <tr><td>Taxable value</td><td className="mono">{rupees(finalBill.subtotal)}</td></tr>
                <tr><td>GST</td><td className="mono">{rupees(finalBill.gstTotal)}</td></tr>
                <tr className="invoice-net"><td>Total</td><td className="mono">{rupees(finalBill.total)}</td></tr>
                <tr><td>Advances</td><td className="mono">− {rupees(finalBill.advancesHeld)}</td></tr>
                {!settled && <tr><td><b>{finalBill.balance >= 0 ? 'To pay' : 'To refund'}</b></td><td className="mono"><b>{rupees(Math.abs(finalBill.balance))}</b></td></tr>}
              </tbody>
            </table>
            {counter && finalBill.status === 'draft' && <div style={{ marginTop: 10 }}><button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { await ipd.finalizeFinalBill(finalBill.id); await ipd.fetchRunningBill(encounterId).then(apply); }, 'Bill finalized')}>Finalize bill</button> <span className="rx-small">After this the bill cannot change.</span></div>}
            {counter && finalBill.status === 'finalized' && <div style={{ marginTop: 10 }}><button className="btn btn-primary" onClick={() => setDialog('settle')}>{finalBill.balance > 0 ? 'Collect payment' : finalBill.balance < 0 ? 'Refund & close' : 'Close the bill'}</button></div>}
          </>
        )}
      </div>

      {dialog === 'charge' && <AddChargeDialog encounterId={encounterId} counter={counter} admittedOn={running.admittedAt ? running.admittedAt.slice(0, 10) : null} onClose={() => setDialog(null)} onDone={(b) => { setDialog(null); void apply(b); }} />}
      {dialog === 'advance' && <AdvanceDialog encounterId={encounterId} onClose={() => setDialog(null)} onDone={({ receipt: r, bill }) => { setDialog(null); void apply(bill); setReceipt(r); }} />}
      {dialog === 'refund' && <RefundDialog encounterId={encounterId} held={running.advancesHeld} onClose={() => setDialog(null)} onDone={({ receipt: r, bill }) => { setDialog(null); void apply(bill); setReceipt(r); }} />}
      {dialog === 'category' && <BillingCategoryDialog bill={running} onClose={() => setDialog(null)} onDone={(b) => { setDialog(null); void apply(b); }} />}
      {dialog === 'discount' && finalBill && <DiscountDialog current={finalBill} onClose={() => setDialog(null)} onSave={async (d) => { if (d === null) await ipd.setBillDiscount(finalBill.id, null); else await ipd.prepareFinalBill(encounterId, d); await ipd.fetchRunningBill(encounterId).then(apply); setDialog(null); }} />}
      {dialog === 'settle' && finalBill && <SettleDialog bill={finalBill} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); notify('Bill settled'); }} />}
      {dialog === 'interim' && <InterimBillPrint running={running} onClose={() => setDialog(null)} />}
      {dialog === 'final' && finalBill && <FinalBillPrint running={running} bill={finalBill} onClose={() => setDialog(null)} />}
      {receipt && <ReceiptPrint running={running} receipt={receipt} onClose={() => setReceipt(null)} />}
      {voiding && <ReasonDialog title="Void this charge" prompt={`Why is "${voiding.description}" being voided? *`} confirmLabel="Void charge" onClose={() => setVoiding(null)}
        onConfirm={async (reason) => { await ipd.voidCharge(encounterId, voiding.id!, reason).then(apply); setVoiding(null); }} />}
      {cancelling && <ReasonDialog title={`Cancel receipt ${cancelling.receiptNo}`} prompt="Why is this receipt being cancelled? *" confirmLabel="Cancel receipt" onClose={() => setCancelling(null)}
        onConfirm={async (reason) => { await ipd.cancelAdvance(encounterId, cancelling.id, reason).then(apply); setCancelling(null); }} />}
    </>
  );
}

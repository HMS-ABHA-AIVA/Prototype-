import { useState } from 'react';
import { PAYMENT_MODES, modeLabel, type OpdInvoice, type PaymentMode } from '../../api/opdBilling';
import { Modal } from '../../components/ui/Modal';
import { useFacility } from '../../components/shared/useFacility';
import { useHospitalStore } from '../../store/useHospitalStore';
import { rupees } from './BillingFields';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const genderWord = (g: string) => (g === 'M' ? 'Male' : g === 'F' ? 'Female' : g ? 'Other' : '');

/**
 * An OPD invoice (it is also the receipt): who, which doctors, at what rates, any discount, how it was paid and by whom, and, if it was
 * cancelled, the refund. It can be reprinted at any time. The billing counter and administrators can cancel it with a refund, as long as no
 * doctor has started seeing the patient.
 */
export function InvoiceDialog({ invoice, onClose, onSlips }: { invoice: OpdInvoice; onClose: () => void; onSlips: (invoice: OpdInvoice) => void }) {
  const { currentRole } = useHospitalStore();
  const facility = useFacility();
  const [current, setCurrent] = useState(invoice);
  const [cancelling, setCancelling] = useState(false);
  const mayCancel = (currentRole === 'biller' || currentRole === 'admin') && current.status === 'paid';
  const cancelled = current.status === 'cancelled';

  const place = [facility?.address, facility?.district, facility?.state, facility?.pincode].filter(Boolean).join(', ');
  const contact = [facility?.phone && `Phone ${facility.phone}`, facility?.email].filter(Boolean).join(' · ');

  if (cancelling) {
    return <CancelDialog invoice={current} onBack={() => setCancelling(false)} onDone={(done) => { setCurrent(done); setCancelling(false); }} />;
  }

  return (
    <Modal title={`OPD invoice ${current.invoiceNo}`} onClose={onClose} width={760}>
      <div className="rx-actions">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>🖨 Print invoice</button>
        <button className="btn btn-sm" onClick={() => onSlips(current)}>Appointment slips ({current.slips.length})</button>
        {mayCancel && <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setCancelling(true)}>Cancel &amp; refund</button>}
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="print-area">
        <div className="rx-sheet invoice-sheet">
          {cancelled && <div className="invoice-stamp">CANCELLED</div>}
          <div className="rx-head">
            <div className="rx-hospital">{facility?.name || 'AIVA OSHealth'}</div>
            {place && <div className="rx-small">{place}</div>}
            {contact && <div className="rx-small">{contact}</div>}
            <div className="slip-title">OPD INVOICE / RECEIPT</div>
          </div>

          <div className="rx-meta">
            <div>
              <div><b>{current.patientName}</b></div>
              <div>{[current.patientAge != null ? `${current.patientAge} yrs` : '', genderWord(current.patientGender)].filter(Boolean).join(' · ')}</div>
              <div className="rx-small">MRN {current.mrn}</div>
            </div>
            <div className="rx-right">
              <div>Invoice: <b className="mono">{current.invoiceNo}</b></div>
              <div className="rx-small">{when(current.collectedAt)}</div>
              {current.panelCode && <div className="rx-small">Panel: <b>{current.panelCode}</b>{current.beneficiaryId ? ` · ${current.beneficiaryId}` : ''}</div>}
            </div>
          </div>

          <table className="rx-table">
            <thead><tr><th>#</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {current.lines.map((line, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{line.label}<div className="rx-small mono">{line.slipNo}</div></td>
                  <td style={{ textAlign: 'right' }} className="mono">{line.amount < 0 ? `− ${rupees(-line.amount)}` : rupees(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="invoice-totals">
            <tbody>
              <tr><td>Total at {current.panelCode ? `${current.panelCode} rates` : 'standard rates'}</td><td className="mono">{rupees(current.grossAmount)}</td></tr>
              {current.discountAmount > 0 && (
                <tr><td>Discount{current.discountType === 'percent' && current.discountValue != null ? ` (${current.discountValue}%)` : ''}{current.discountReason ? `: ${current.discountReason}` : ''}</td><td className="mono">− {rupees(current.discountAmount)}</td></tr>
              )}
              <tr className="invoice-net"><td>Net amount paid</td><td className="mono">{rupees(current.amount)}</td></tr>
            </tbody>
          </table>

          <div className="rx-line rx-small">
            Paid by <b>{modeLabel(current.mode)}</b>{current.reference ? ` · ref ${current.reference}` : ''}
            {current.amountReceived != null ? ` · cash received ${rupees(current.amountReceived)}${current.change ? `, change ${rupees(current.change)}` : ''}` : ''}
            {' · '}billed by <b>{current.collectedByName}</b>
          </div>

          {cancelled && (
            <div className="invoice-refund">
              <b>Cancelled</b> on {current.cancelledAt ? when(current.cancelledAt) : ''} by {current.cancelledByName}: {current.cancelReason}.<br />
              Refunded <b className="mono">{rupees(current.refundAmount ?? 0)}</b>
              {current.refundMode ? ` by ${modeLabel(current.refundMode)}` : ''}{current.refundReference ? ` · ref ${current.refundReference}` : ''}.
            </div>
          )}

          <div className="rx-small" style={{ marginTop: 14 }}>Computer-generated invoice. Please keep it with the appointment slips.</div>
        </div>
      </div>
    </Modal>
  );
}

/** Cancels an invoice and records the refund: a reason, how much goes back, and how. */
function CancelDialog({ invoice, onBack, onDone }: { invoice: OpdInvoice; onBack: () => void; onDone: (invoice: OpdInvoice) => void }) {
  const { cancelOpdInvoice, currentStaff } = useHospitalStore();
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(String(invoice.amount));
  const [mode, setMode] = useState<PaymentMode>(invoice.mode);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const refund = Number(amount);
  const badAmount = !(refund >= 0) || refund > invoice.amount;
  const needsReference = refund > 0 && (mode === 'upi' || mode === 'card');
  const problem = reason.trim().length < 3 ? 'Give a reason' : badAmount ? `The refund can be ₹0 to ${rupees(invoice.amount)}` : needsReference && reference.trim().length < 3 ? 'Enter the refund reference' : null;

  async function confirm() {
    if (busy || problem) return;
    if (!window.confirm(`Cancel ${invoice.invoiceNo} and refund ${rupees(refund)} to ${invoice.patientName}? Their tokens and appointment slips will no longer be valid.`)) return;
    setBusy(true);
    const done = await cancelOpdInvoice(invoice.id, {
      reason: reason.trim(), refundAmount: refund, refundMode: refund > 0 ? mode : undefined, refundReference: reference.trim() || undefined,
    });
    setBusy(false);
    if (done) onDone(done);
  }

  return (
    <Modal title={`Cancel & refund ${invoice.invoiceNo}`} onClose={onBack} width={560}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
        <b>{invoice.patientName}</b> · {invoice.mrn} · paid {rupees(invoice.amount)} by {modeLabel(invoice.mode)}. Cancelling voids the invoice and the {invoice.slips.length} consultation{invoice.slips.length === 1 ? '' : 's'} on it
        ({invoice.slips.map((s) => s.doctorName ?? s.department).join(', ')}). It can only be done before a doctor has started seeing the patient.
      </p>
      <div className="field">
        <label>Reason for cancelling *</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Billed to the wrong doctor, patient left, duplicate invoice" />
      </div>
      <div className="two-col">
        <div className="field">
          <label>Refund amount (₹)</label>
          <input type="number" min={0} max={invoice.amount} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="ai-hint">Everything by default. Enter less to keep a cancellation charge.</div>
        </div>
        <div className="field">
          <label>Refund mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
            {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>
      {refund > 0 && (
        <div className="field">
          <label>{mode === 'upi' ? 'UPI refund transaction id *' : mode === 'card' ? 'Card refund slip no. *' : 'Refund reference (optional)'}</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
        </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Recorded against <b>{currentStaff.name}</b>.</div>
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onBack}>Back</button>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={confirm}>{busy ? 'Cancelling…' : `Cancel invoice & refund ${rupees(Number.isFinite(refund) ? refund : 0)}`}</button>
      </div>
    </Modal>
  );
}

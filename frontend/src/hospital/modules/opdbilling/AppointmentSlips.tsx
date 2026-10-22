import { useState } from 'react';
import { modeLabel, type AppointmentSlip, type OpdInvoice } from '../../api/opdBilling';
import { Modal } from '../../components/ui/Modal';
import { useFacility } from '../../components/shared/useFacility';
import { rupees } from './BillingFields';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const genderWord = (g: string) => (g === 'M' ? 'Male' : g === 'F' ? 'Female' : g ? 'Other' : '');

/**
 * One appointment slip for each doctor the patient is seeing, for an invoice. "Print all" gives each slip its own page; each slip can also be
 * printed on its own. (The browser's print window can save them as a PDF.) A cancelled invoice's slips are not valid and cannot be printed.
 */
export function SlipsDialog({ invoice, onClose, onBack }: { invoice: OpdInvoice; onClose: () => void; onBack?: () => void }) {
  const facility = useFacility();
  // While one slip is being printed on its own, the others are hidden from the page (see .no-print in global.css).
  const [only, setOnly] = useState<string | null>(null);
  const cancelled = invoice.status === 'cancelled';

  function print(slipId: string | null) {
    setOnly(slipId);
    // let the page apply which slips to show before the print window opens
    setTimeout(() => {
      window.print();
      setOnly(null);
    }, 80);
  }

  const place = [facility?.address, facility?.district, facility?.state, facility?.pincode].filter(Boolean).join(', ');
  const contact = [facility?.phone && `Phone ${facility.phone}`, facility?.email].filter(Boolean).join(' · ');

  return (
    <Modal title={`Appointment slips · ${invoice.invoiceNo}`} onClose={onClose} width={760}>
      <div className="rx-actions">
        {!cancelled && <button className="btn btn-primary btn-sm" onClick={() => print(null)}>🖨 Print all {invoice.slips.length} slip{invoice.slips.length === 1 ? '' : 's'}</button>}
        {onBack && <button className="btn btn-sm" onClick={onBack}>← Invoice</button>}
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      {cancelled && <div className="ai-demo-warning">This invoice was cancelled and refunded, so its slips are no longer valid.</div>}

      <div className="slip-summary">
        <div><b>{invoice.patientName}</b> <span className="mono">{invoice.mrn}</span></div>
        <div>
          {rupees(invoice.amount)} · {modeLabel(invoice.mode)}
          {invoice.reference ? ` · ref ${invoice.reference}` : ''}
          {invoice.change != null && invoice.change > 0 ? ` · change ${rupees(invoice.change)}` : ''}
          {invoice.panelCode ? ` · ${invoice.panelCode}` : ''}
        </div>
        <div style={{ color: 'var(--ink-soft)', fontSize: 12 }}>Billed by {invoice.collectedByName} · {when(invoice.collectedAt)}</div>
      </div>

      <div className="print-area">
        {invoice.slips.map((slip) => (
          <Slip
            key={slip.billId}
            slip={slip}
            heading={{ name: facility?.name || 'AIVA OSHealth', place, contact }}
            hidden={cancelled || (only !== null && only !== slip.billId)}
            canPrint={!cancelled}
            onPrint={() => print(slip.billId)}
          />
        ))}
      </div>
    </Modal>
  );
}

function Slip({ slip, heading, hidden, canPrint, onPrint }: { slip: AppointmentSlip; heading: { name: string; place: string; contact: string }; hidden: boolean; canPrint: boolean; onPrint: () => void }) {
  return (
    <div className={`slip${hidden ? ' no-print' : ''}`}>
      <div className="rx-head">
        <div className="rx-hospital">{heading.name}</div>
        {heading.place && <div className="rx-small">{heading.place}</div>}
        {heading.contact && <div className="rx-small">{heading.contact}</div>}
        <div className="slip-title">OPD APPOINTMENT SLIP</div>
      </div>

      <div className="slip-token">
        <div className="rx-small">{slip.department.toUpperCase()}</div>
        <div className="mono slip-token-no">{slip.tokenNo != null ? `#${slip.tokenNo}` : '—'}</div>
        <div className="rx-small">TOKEN</div>
      </div>

      <table className="slip-table">
        <tbody>
          <tr><td>Patient</td><td><b>{slip.patientName}</b> · {[slip.age != null ? `${slip.age} yrs` : '', genderWord(slip.gender)].filter(Boolean).join(' · ')}</td></tr>
          <tr><td>MRN</td><td className="mono">{slip.mrn}</td></tr>
          <tr><td>Doctor</td><td><b>{slip.doctorName ?? '—'}</b>{slip.doctorHprId ? <span className="rx-small"> · HPR {slip.doctorHprId}</span> : null}</td></tr>
          <tr><td>Speciality</td><td>{slip.department}</td></tr>
          <tr><td>Consultation fee</td><td className="mono">{rupees(slip.fee)} · paid by {modeLabel(slip.paymentMode)}</td></tr>
          <tr><td>Slip / Invoice</td><td className="mono">{slip.slipNo} · {slip.receiptNo}</td></tr>
          <tr><td>Date and time</td><td>{when(slip.collectedAt)}</td></tr>
          <tr><td>Billed by</td><td>{slip.collectedByName}</td></tr>
        </tbody>
      </table>
      <div className="rx-small" style={{ marginTop: 8 }}>Please show this slip at the consultation room of {slip.doctorName ?? 'the doctor'} and wait for token {slip.tokenNo != null ? `#${slip.tokenNo}` : ''} to be called.</div>

      {canPrint && (
        <div className="slip-actions no-print-btn">
          <button className="btn btn-sm" onClick={onPrint}>🖨 Print this slip</button>
        </div>
      )}
    </div>
  );
}

import { modeLabel } from '../../api/opdBilling';
import type { FinalBill, Receipt, RunningBill } from '../../api/ipd';
import { PrintDialog, SheetFooter, SheetHeader, SignatureRow, ageOf, day, genderWord, when } from '../../components/print/PrintSheet';
import { rupeesInWords } from '../../utils/inWords';
import { rupees } from '../opdbilling/BillingFields';

/** Who the bill is for and where they stayed. */
function PatientBlock({ running }: { running: RunningBill }) {
  const stay = [running.bed && `${running.bed.ward} ${running.bed.bedNo}`, running.department].filter(Boolean).join(' · ');
  return (
    <div className="rx-meta">
      <div>
        <div><b>{running.patient.name}</b></div>
        <div>{[ageOf(running.patient.yearOfBirth), genderWord(running.patient.gender)].filter(Boolean).join(' · ')}</div>
        <div className="rx-small">MRN {running.patient.mrn}{running.patient.phone ? ` · ${running.patient.phone}` : ''}</div>
        {running.panel && <div className="rx-small">Billed under <b>{running.panel.code}</b>{running.beneficiaryId ? ` · card ${running.beneficiaryId}` : ''}</div>}
      </div>
      <div className="rx-right">
        <div className="rx-small">{stay}</div>
        <div className="rx-small">Doctor: {running.doctorName ?? '—'}</div>
        <div className="rx-small">Admitted {when(running.admittedAt)}</div>
        <div className="rx-small">{running.dischargedAt ? `Discharged ${when(running.dischargedAt)}` : 'Still admitted'}</div>
      </div>
    </div>
  );
}

const money = (n: number) => (n < 0 ? `− ${rupees(-n)}` : rupees(n));

/** The cost of the stay so far (while the patient is in) or as it stands before the final bill. */
export function InterimBillPrint({ running, onClose }: { running: RunningBill; onClose: () => void }) {
  const lines = running.lines.filter((l) => !l.voided);
  return (
    <PrintDialog title={`Running bill · ${running.patient.name}`} onClose={onClose}>
      <div className="rx-sheet">
        <SheetHeader title="INTERIM BILL" subtitle={`Charges up to ${when(new Date().toISOString())}. This is not the final bill.`} />
        <PatientBlock running={running} />
        <table className="rx-table">
          <thead><tr><th>Date</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id ?? `${l.source}-${i}`}>
                <td>{l.date ? day(l.date) : ''}</td><td>{l.description}</td>
                <td style={{ textAlign: 'right' }}>{l.qty}</td><td style={{ textAlign: 'right' }} className="mono">{rupees(l.rate)}</td>
                <td style={{ textAlign: 'right' }}>{l.gstPct}%</td><td style={{ textAlign: 'right' }} className="mono">{rupees(l.amount)}</td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={6}>Nothing has been charged yet.</td></tr>}
          </tbody>
        </table>
        <table className="invoice-totals">
          <tbody>
            <tr><td>Sub-total</td><td className="mono">{rupees(running.subtotal)}</td></tr>
            <tr><td>GST</td><td className="mono">{rupees(running.gstTotal)}</td></tr>
            <tr className="invoice-net"><td>Total so far</td><td className="mono">{rupees(running.total)}</td></tr>
            <tr><td>Advances paid</td><td className="mono">− {rupees(running.advancesHeld)}</td></tr>
            <tr><td><b>{running.balance >= 0 ? 'Balance to pay' : 'Refund due to patient'}</b></td><td className="mono"><b>{rupees(Math.abs(running.balance))}</b></td></tr>
          </tbody>
        </table>
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

/** The final bill: a tax invoice for the stay, with the discount, advances and how it was settled. */
export function FinalBillPrint({ running, bill, onClose }: { running: RunningBill; bill: FinalBill; onClose: () => void }) {
  const paid = bill.status === 'paid';
  return (
    <PrintDialog title={`Bill ${bill.billNo}`} onClose={onClose}>
      <div className="rx-sheet invoice-sheet">
        {bill.status === 'draft' && <div className="invoice-stamp" style={{ fontSize: 40 }}>DRAFT</div>}
        <SheetHeader title="FINAL BILL / TAX INVOICE" subtitle={`Bill no. ${bill.billNo} · ${day(bill.createdAt)}`} />
        <PatientBlock running={running} />
        <table className="rx-table">
          <thead><tr><th>#</th><th>Description</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>GST</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {bill.items.map((item, i) => (
              <tr key={item.id}>
                <td>{i + 1}</td><td>{item.label}</td>
                <td style={{ textAlign: 'right' }}>{item.qty}</td><td style={{ textAlign: 'right' }} className="mono">{money(item.rate)}</td>
                <td style={{ textAlign: 'right' }}>{item.gstPct}%</td><td style={{ textAlign: 'right' }} className="mono">{money(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="invoice-totals">
          <tbody>
            <tr><td>Taxable value{bill.discountAmount > 0 ? ` (after ${rupees(bill.discountAmount)} discount${bill.discountReason ? `: ${bill.discountReason}` : ''})` : ''}</td><td className="mono">{rupees(bill.subtotal)}</td></tr>
            <tr><td>GST</td><td className="mono">{rupees(bill.gstTotal)}</td></tr>
            <tr className="invoice-net"><td>Total</td><td className="mono">{rupees(bill.total)}</td></tr>
            <tr><td>Advances paid</td><td className="mono">− {rupees(bill.advancesHeld)}</td></tr>
            {!paid && <tr><td><b>{bill.balance >= 0 ? 'Balance to pay' : 'Refund due to patient'}</b></td><td className="mono"><b>{rupees(Math.abs(bill.balance))}</b></td></tr>}
          </tbody>
        </table>
        <div className="rx-small" style={{ marginTop: 8 }}>{rupeesInWords(bill.total)}</div>
        {paid && (
          <div className="rx-line rx-small">
            Settled on {when(bill.paidAt)} by <b>{modeLabel(bill.paymentMode ?? 'cash')}</b>
            {bill.settlement.map((r) => ` · ${r.kind === 'refund' ? 'refund' : 'paid'} ${rupees(r.amount)} (receipt ${r.receiptNo}${r.reference ? `, ref ${r.reference}` : ''})`).join('')}
          </div>
        )}
        <SignatureRow labels={['Patient / representative', 'Billing officer']} />
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

const RECEIPT_TITLE = { advance: 'ADVANCE RECEIPT', refund: 'REFUND RECEIPT', settlement: 'PAYMENT RECEIPT' } as const;

/** One receipt: an advance taken, a refund given, or the settlement of the final bill. */
export function ReceiptPrint({ running, receipt, onClose }: { running: RunningBill; receipt: Receipt; onClose: () => void }) {
  return (
    <PrintDialog title={`Receipt ${receipt.receiptNo}`} onClose={onClose} width={640}>
      <div className="rx-sheet invoice-sheet">
        {receipt.cancelled && <div className="invoice-stamp">CANCELLED</div>}
        <SheetHeader title={RECEIPT_TITLE[receipt.kind]} />
        <div className="rx-meta">
          <div>
            <div><b>{running.patient.name}</b></div>
            <div className="rx-small">MRN {running.patient.mrn}{running.bed ? ` · ${running.bed.ward} ${running.bed.bedNo}` : ''}</div>
          </div>
          <div className="rx-right">
            <div>Receipt: <b className="mono">{receipt.receiptNo}</b></div>
            <div className="rx-small">{when(receipt.at)}</div>
          </div>
        </div>
        <table className="slip-table">
          <tbody>
            <tr><td>{receipt.kind === 'refund' ? 'Refunded' : 'Received'}</td><td><b className="mono" style={{ fontSize: 16 }}>{rupees(receipt.amount)}</b></td></tr>
            <tr><td>In words</td><td>{rupeesInWords(receipt.amount)}</td></tr>
            <tr><td>Mode</td><td>{modeLabel(receipt.mode)}{receipt.reference ? ` · ref ${receipt.reference}` : ''}</td></tr>
            {receipt.note && <tr><td>Note</td><td>{receipt.note}</td></tr>}
            <tr><td>{receipt.kind === 'refund' ? 'Paid out by' : 'Received by'}</td><td>{receipt.receivedBy}</td></tr>
          </tbody>
        </table>
        {receipt.cancelled && <div className="invoice-refund"><b>Cancelled</b> by {receipt.cancelledBy}: {receipt.cancelReason}</div>}
        {receipt.kind === 'advance' && <div className="rx-small" style={{ marginTop: 8 }}>This amount is held against the patient's bill and will be adjusted in the final bill.</div>}
        <SignatureRow labels={['Patient / representative', 'Cashier']} />
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

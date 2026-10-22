import { useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import * as ipd from '../../api/ipd';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { DiscountDialog, SettleDialog } from '../ipdbilling/IpdBillDialogs';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { Link } from 'react-router-dom';
import { PAYMENT_MODES } from '../../api/opdBilling';
import type { Bill } from '../../types';

export function BillingPage() {
  const { bills, patients, encounters, finalizeBill, markBillPaid, loadBills } = useHospitalStore();
  useRefresh(['bills', 'patients'], 30);
  const [viewBill, setViewBill] = useState<Bill | null>(null);

  const sorted = [...bills].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <>
      <div className="os-head">
        <div>
          <h1>Billing & Insurance</h1>
          <div className="sub">OPD consultation fees are collected first; invoices cover tests, medicines, ER and inpatient stays</div>
        </div>
      </div>

      <div className="card" style={{ background: 'var(--brand-soft)' }}>
        <div className="flex-between">
          <div>
            <b>OPD consultation invoices have their own screen.</b>
            <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Billing the doctors, panel rates and discounts, reprinting invoices, and refunds are all on OPD Billing.</div>
          </div>
          <Link to="/opd-billing" className="btn btn-primary btn-sm">Open OPD Billing →</Link>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Bill ID</th>
              <th>Patient</th>
              <th>Encounter</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => {
              const patient = patients.find((p) => p.id === b.patientId);
              const encounter = encounters.find((e) => e.id === b.encounterId);
              const total = billTotal(b);
              return (
                <tr key={b.id}>
                  <td className="mono">{b.billNo ?? b.id.toUpperCase()}</td>
                  <td style={{ fontWeight: 500 }}>{patient?.name}</td>
                  <td>
                    <Badge tone="neutral">{b.encounterType ?? encounter?.type}</Badge>
                    {b.kind === 'opd_fee' && <> <Badge tone="info">Consultation fee</Badge></>}
                  </td>
                  <td className="num mono">₹{total.toFixed(2)}</td>
                  <td>
                    {b.status === 'draft' && <Badge tone="warn">Draft</Badge>}
                    {b.status === 'finalized' && <Badge tone="ok">Finalized</Badge>}
                    {b.status === 'paid' && <Badge tone="ok">Paid{b.paymentMode ? ` · ${PAYMENT_MODES.find((m) => m.value === b.paymentMode)?.label ?? b.paymentMode}` : ''}</Badge>}
                    {b.status === 'void' && <Badge tone="neutral">Cancelled</Badge>}
                  </td>
                  <td>
                    <button className="btn btn-sm" onClick={() => setViewBill(b)}>View Invoice</button>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={6} className="empty-state">No bills yet. Collect an OPD consultation fee, or close a consultation with tests or medicines, or discharge an inpatient.</td></tr>}
          </tbody>
        </table>
      </div>

      {viewBill && apiEnabled && (
        <ApiBillModal bill={viewBill} patientName={patients.find((p) => p.id === viewBill.patientId)?.name ?? ''} onClose={() => { setViewBill(null); void loadBills(); }} />
      )}

      {viewBill && !apiEnabled && (
        <Modal title={`Invoice ${viewBill.billNo ?? viewBill.id.toUpperCase()}`} onClose={() => setViewBill(null)} width={520}>
          <InvoiceDetail bill={viewBill} patientName={patients.find((p) => p.id === viewBill.patientId)?.name ?? ''} />
          {viewBill.status === 'finalized' && (
            <div className="flex-between" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setViewBill(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => { markBillPaid(viewBill.id); setViewBill(null); }}>
                Mark as Paid
              </button>
            </div>
          )}
          {viewBill.status === 'draft' && viewBill.kind !== 'opd_fee' && (
            <div className="flex-between" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setViewBill(null)}>Close</button>
              <button
                className="btn btn-primary"
                onClick={() => { finalizeBill(viewBill.id); setViewBill(null); }}
              >
                Finalize Invoice
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function billTotal(b: Bill) {
  return b.items.reduce((sum, item) => sum + item.qty * item.rate * (1 + item.gstPct / 100), 0);
}

function InvoiceDetail({ bill, patientName }: { bill: Bill; patientName: string }) {
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 14 }}>Patient: <b>{patientName}</b></p>
      <table className="table">
        <thead>
          <tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          {bill.items.map((item, i) => (
            <tr key={i}>
              <td>{item.label}</td>
              <td className="num mono">{item.qty}</td>
              <td className="num mono">₹{item.rate.toFixed(2)}</td>
              <td className="num mono">{item.gstPct}%</td>
              <td className="num mono">₹{(item.qty * item.rate * (1 + item.gstPct / 100)).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex-between" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <span style={{ fontWeight: 600 }}>Total</span>
        <span className="mono" style={{ fontWeight: 700, fontSize: 16 }}>₹{billTotal(bill).toFixed(2)}</span>
      </div>
    </div>
  );
}

/**
 * A bill with the server's full picture (discount, tax, what is still to pay). The billing counter can give a discount on a draft, finalize it,
 * and take the payment, which records the mode and its reference. An admission's bill is worked on in IPD Billing, where its charges and advances are.
 */
function ApiBillModal({ bill, patientName, onClose }: { bill: Bill; patientName: string; onClose: () => void }) {
  const role = useHospitalStore((s) => s.currentRole);
  const counter = role === 'biller' || role === 'admin';
  const [detail, setDetail] = useState<ipd.FinalBill | null>(null);
  const [dialog, setDialog] = useState<'discount' | 'settle' | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => ipd.fetchBill(bill.id).then(setDetail, reportError);
  useEffect(() => { void reload(); }, [bill.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isIpd = bill.encounterType === 'IPD';
  const money = (n: number) => (n < 0 ? '− ' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function finalize() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      await ipd.finalizeFinalBill(detail.id);
      useNoticeStore.getState().show('Bill finalized', 'info');
      await reload();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Invoice ${bill.billNo ?? bill.id.toUpperCase()}`} onClose={onClose} width={620}>
      {!detail ? <div className="empty-state">Loading…</div> : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginBottom: 14 }}>Patient: <b>{patientName}</b> · {detail.status === 'paid' ? 'Paid' : detail.status === 'finalized' ? 'Finalized, awaiting payment' : 'Draft'}</p>
          <table className="table">
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {detail.items.map((i) => (
                <tr key={i.id}><td>{i.label}</td><td className="num mono">{i.qty}</td><td className="num mono">{money(i.rate)}</td><td className="num">{i.gstPct}%</td><td className="num mono">{money(i.amount)}</td></tr>
              ))}
            </tbody>
          </table>
          <table className="invoice-totals">
            <tbody>
              <tr><td>Taxable value</td><td className="mono">{money(detail.subtotal)}</td></tr>
              <tr><td>GST</td><td className="mono">{money(detail.gstTotal)}</td></tr>
              <tr className="invoice-net"><td>Total</td><td className="mono">{money(detail.total)}</td></tr>
            </tbody>
          </table>
          <div className="flex-between" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            {isIpd ? (
              <Link to={`/ipd-billing/${bill.encounterId}`} className="btn btn-primary" onClick={onClose}>Open in IPD Billing →</Link>
            ) : counter && detail.kind === 'final' && (
              <div className="row">
                {detail.status === 'draft' && <button className="btn" onClick={() => setDialog('discount')}>{detail.discountType ? 'Change discount' : 'Give a discount'}</button>}
                {detail.status === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={finalize}>Finalize Invoice</button>}
                {detail.status === 'finalized' && <button className="btn btn-primary" onClick={() => setDialog('settle')}>Collect payment</button>}
              </div>
            )}
          </div>
        </>
      )}
      {dialog === 'discount' && detail && <DiscountDialog current={detail} onClose={() => setDialog(null)} onSave={async (d) => { setDetail(await ipd.setBillDiscount(detail.id, d)); setDialog(null); }} />}
      {dialog === 'settle' && detail && <SettleDialog bill={detail} onClose={() => setDialog(null)} onDone={() => { setDialog(null); useNoticeStore.getState().show('Payment recorded', 'info'); void reload(); }} />}
    </Modal>
  );
}

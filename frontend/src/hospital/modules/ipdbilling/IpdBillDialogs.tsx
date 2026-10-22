import { useEffect, useState, type FormEvent } from 'react';
import { PAYMENT_MODES, type PaymentMode } from '../../api/opdBilling';
import { fetchServices, type Service } from '../../api/masters';
import * as ipd from '../../api/ipd';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import { reportError } from '../../store/useNoticeStore';
import { PaymentFields, emptyPayment, paymentProblem, rupees, type PaymentState } from '../opdbilling/BillingFields';

const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

function Failure({ message }: { message: string | null }) {
  return message ? <div className="login-error" role="alert">{message}</div> : null;
}

/** Adds a service from the hospital's list to the stay. The billing counter may also change the rate (with a reason) or add an item that is not on the list. */
export function AddChargeDialog({ encounterId, counter, admittedOn, onClose, onDone }: { encounterId: string; counter: boolean; admittedOn: string | null; onClose: () => void; onDone: (bill: ipd.RunningBill) => void }) {
  const [services, setServices] = useState<Service[]>([]);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Service | null>(null);
  const [custom, setCustom] = useState(false);
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');
  const [changeRate, setChangeRate] = useState(false);
  const [rate, setRate] = useState('');
  const [rateNote, setRateNote] = useState('');
  const [gst, setGst] = useState('0');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { fetchServices().then((all) => setServices(all.filter((s) => s.category !== 'bed')), reportError); }, []);

  const shown = services.filter((s) => !search || `${s.name} ${s.code}`.toLowerCase().includes(search.toLowerCase())).slice(0, 40);
  const quantity = Math.floor(num(qty));
  const problem = !(quantity >= 1) ? 'Enter a quantity'
    : custom ? (description.trim().length < 2 ? 'Describe the item' : !(num(rate) >= 0) ? 'Enter the rate' : null)
    : !picked ? 'Choose a service'
    : changeRate && (!(num(rate) >= 0) || rateNote.trim().length < 3) ? 'Enter the new rate and the reason' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      const input: ipd.ChargeInput = custom
        ? { description: description.trim(), qty: quantity, rate: num(rate), gstPct: num(gst) || 0, rateNote: rateNote.trim() || undefined, date }
        : { serviceId: picked!.id, qty: quantity, ...(changeRate ? { rate: num(rate), rateNote: rateNote.trim() } : {}), date };
      onDone(await ipd.addCharge(encounterId, input));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the charge');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a charge" onClose={onClose} width={600}>
      <form onSubmit={submit}>
        <Failure message={error} />
        {!custom && (
          <>
            <div className="field"><label>Service</label><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the hospital's services" autoFocus /></div>
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10 }}>
              {shown.map((s) => (
                <div key={s.id} onClick={() => { setPicked(s); setRate(String(s.price)); }}
                  style={{ padding: '7px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', background: picked?.id === s.id ? 'var(--brand-soft)' : undefined, borderBottom: '1px solid var(--border)' }}>
                  <span>{s.name} <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{s.code}</span></span>
                  <span className="mono">{rupees(s.price)}</span>
                </div>
              ))}
              {shown.length === 0 && <div className="empty-state">{services.length === 0 ? 'No services have been set up yet. An administrator adds them under Masters.' : 'No match.'}</div>}
            </div>
          </>
        )}
        {custom && (
          <>
            <div className="field"><label>Description *</label><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} autoFocus placeholder="e.g. Oxygen cylinder" /></div>
            <div className="two-col">
              <div className="field"><label>Rate (₹) *</label><input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></div>
              <div className="field"><label>GST %</label><input type="number" min={0} max={100} value={gst} onChange={(e) => setGst(e.target.value)} /></div>
            </div>
          </>
        )}
        <div className="two-col">
          <div className="field"><label>Quantity</label><input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="field"><label>Date</label><input type="date" value={date} min={admittedOn ?? undefined} max={today()} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        {counter && !custom && picked && (
          <>
            <label className="row" style={{ cursor: 'pointer', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={changeRate} onChange={(e) => setChangeRate(e.target.checked)} />Change the rate for this patient</label>
            {changeRate && (
              <div className="two-col">
                <div className="field"><label>Rate (₹)</label><input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></div>
                <div className="field"><label>Reason *</label><input value={rateNote} onChange={(e) => setRateNote(e.target.value)} maxLength={200} placeholder="e.g. Package rate agreed" /></div>
              </div>
            )}
          </>
        )}
        {counter && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setCustom(!custom); setPicked(null); setRate(''); }}>{custom ? '← Choose from the services list' : 'The item is not on the list…'}</button>}
        {!custom && picked && <div className="ai-hint" style={{ marginTop: 6 }}>The rate follows the patient's billing category (a panel's own rate is used when it has one).</div>}
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Adding…' : 'Add charge'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Voiding a charge needs a reason, which stays on the record. */
export function ReasonDialog({ title, prompt, confirmLabel, onClose, onConfirm }: { title: string; prompt: string; confirmLabel: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not do that');
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={460}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="field"><label>{prompt}</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Takes money in advance, against the stay's bill. */
export function AdvanceDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: (result: { receipt: ipd.Receipt; bill: ipd.RunningBill }) => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<PaymentState>(emptyPayment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = num(amount);
  const problem = !(value > 0) ? 'Enter the amount' : paymentProblem({ ...payment, cash: '' }, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ipd.takeAdvance(encounterId, { amount: value, mode: payment.mode, reference: payment.reference.trim() || undefined, note: note.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the advance');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Take an advance" onClose={onClose} width={560}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="field"><label>Amount (₹) *</label><input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
        <PaymentFields value={payment} onChange={setPayment} total={0} />
        <div className="field" style={{ marginTop: 8 }}><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Saving…' : `Receive ${value > 0 ? rupees(value) : ''}`}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Gives back part of the advance during the stay. */
export function RefundDialog({ encounterId, held, onClose, onDone }: { encounterId: string; held: number; onClose: () => void; onDone: (result: { receipt: ipd.Receipt; bill: ipd.RunningBill }) => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = num(amount);
  const problem = !(value > 0) || value > held ? `Enter an amount up to ${rupees(held)}` : reason.trim().length < 3 ? 'Give a reason' : (mode === 'upi' || mode === 'card') && reference.trim().length < 3 ? 'Enter the reference' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ipd.refundAdvance(encounterId, { amount: value, mode, reference: reference.trim() || undefined, reason: reason.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the refund');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Refund part of the advance" onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="ai-hint" style={{ marginBottom: 8 }}>Advance held: <b>{rupees(held)}</b></div>
        <div className="two-col">
          <div className="field"><label>Amount (₹) *</label><input type="number" min={1} max={held} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
          <div className="field"><label>Refund mode</label><select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>{PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>
        </div>
        {(mode === 'upi' || mode === 'card') && <div className="field"><label>{mode === 'upi' ? 'UPI transaction id *' : 'Card slip no. *'}</label><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></div>}
        <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Saving…' : 'Refund'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Self-pay, or a panel (CGHS, DGHS ...) with the beneficiary's card number. Optionally re-rates the charges already on the bill. */
export function BillingCategoryDialog({ bill, onClose, onDone }: { bill: ipd.RunningBill; onClose: () => void; onDone: (bill: ipd.RunningBill) => void }) {
  const { panels } = useHospitalStore();
  useRefresh(['panels']);
  const [panelId, setPanelId] = useState(bill.panel?.id ?? '');
  const [beneficiary, setBeneficiary] = useState(bill.beneficiaryId ?? '');
  const [reprice, setReprice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = panels.find((p) => p.id === panelId);
  const problem = panel?.requiresBeneficiaryId && beneficiary.trim().length < 3 ? `Enter the ${panel.code} beneficiary / card number` : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ipd.setBillingCategory(bill.encounterId, panelId || null, beneficiary.trim() || undefined, reprice));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the billing category');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Billing category" onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <div className="field">
          <label>Billed as</label>
          <select value={panelId} onChange={(e) => { setPanelId(e.target.value); setBeneficiary(''); }}>
            <option value="">Self-pay (standard rates)</option>
            {panels.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </select>
        </div>
        {panel && <div className="field"><label>{panel.code} beneficiary / card no.{panel.requiresBeneficiaryId ? ' *' : ''}</label><input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} maxLength={60} /></div>}
        <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" style={{ width: 'auto' }} checked={reprice} onChange={(e) => setReprice(e.target.checked)} />Re-rate the charges already on the bill (rates changed by hand are kept)</label>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** A discount on the final bill (percent or amount), with the reason. */
export function DiscountDialog({ current, onClose, onSave }: { current: ipd.FinalBill; onClose: () => void; onSave: (discount: ipd.DiscountInput | null) => Promise<void> }) {
  const [type, setType] = useState<'percent' | 'amount'>(current.discountType ?? 'percent');
  const [value, setValue] = useState(current.discountValue != null ? String(current.discountValue) : '');
  const [reason, setReason] = useState(current.discountReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = !(num(value) > 0) ? 'Enter the discount' : reason.trim().length < 3 ? 'Give a reason' : null;

  const run = async (discount: ipd.DiscountInput | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(discount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the discount');
      setBusy(false);
    }
  };

  return (
    <Modal title="Discount on the final bill" onClose={onClose} width={500}>
      <Failure message={error} />
      <div className="two-col">
        <div className="field"><label>Type</label><select value={type} onChange={(e) => setType(e.target.value as 'percent' | 'amount')}><option value="percent">Percent %</option><option value="amount">Amount ₹</option></select></div>
        <div className="field"><label>{type === 'percent' ? 'Percent' : 'Amount'}</label><input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></div>
      </div>
      <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Senior citizen, staff family" /></div>
      <div className="ai-hint">The discount is shared across the GST rates in proportion, so the tax stays right. It is recorded with your name.</div>
      <div className="flex-between" style={{ marginTop: 16 }}>
        <div className="row">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {current.discountType && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(null)}>Remove discount</button>}
        </div>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={() => run({ type, value: num(value), reason: reason.trim() })}>{busy ? 'Saving…' : 'Apply discount'}</button>
      </div>
    </Modal>
  );
}

/** Settles the final bill: what is left after the advances is collected, or (if the advances were more) given back. */
export function SettleDialog({ bill, onClose, onDone }: { bill: ipd.FinalBill; onClose: () => void; onDone: (bill: ipd.FinalBill) => void }) {
  const [payment, setPayment] = useState<PaymentState>(emptyPayment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = bill.balance;
  const problem = due === 0 ? null : paymentProblem(payment, due > 0 ? due : 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ipd.payFinalBill(bill.id, { paymentMode: payment.mode, reference: payment.reference.trim() || undefined, amountReceived: due > 0 && payment.mode === 'cash' && payment.cash.trim() !== '' ? Number(payment.cash) : undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not settle the bill');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Settle ${bill.billNo}`} onClose={onClose} width={560}>
      <form onSubmit={submit}>
        <Failure message={error} />
        <table className="invoice-totals" style={{ marginBottom: 12 }}>
          <tbody>
            <tr><td>Bill total</td><td className="mono">{rupees(bill.total)}</td></tr>
            <tr><td>Advances paid</td><td className="mono">− {rupees(bill.advancesHeld)}</td></tr>
            <tr className="invoice-net"><td>{due > 0 ? 'To collect' : due < 0 ? 'To give back to the patient' : 'Nothing more to pay'}</td><td className="mono">{rupees(Math.abs(due))}</td></tr>
          </tbody>
        </table>
        {due === 0 ? <div className="ai-hint">The advances cover the bill exactly. Confirming closes the bill.</div> : <PaymentFields value={payment} onChange={setPayment} total={due > 0 ? due : 0} refund={due < 0} />}
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined}>{busy ? 'Saving…' : due > 0 ? `Collect ${rupees(due)}` : due < 0 ? `Refund ${rupees(-due)}` : 'Close the bill'}</button>
        </div>
      </form>
    </Modal>
  );
}

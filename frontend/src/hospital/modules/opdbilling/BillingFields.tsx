import { useEffect, useState } from 'react';
import { PAYMENT_MODES, type ConsultationRequest, type PaymentDetails, type PaymentMode, type PricingChoice, type Quote } from '../../api/opdBilling';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';

export const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Payment details -------------------------------------------------------------------------------------

export interface PaymentState { mode: PaymentMode; reference: string; cash: string }
export const emptyPayment: PaymentState = { mode: 'cash', reference: '', cash: '' };

/** Why the payment cannot be taken yet, or null when the details are complete. */
export function paymentProblem(p: PaymentState, total: number): string | null {
  if ((p.mode === 'upi' || p.mode === 'card') && p.reference.trim().length < 3) return p.mode === 'upi' ? 'Enter the UPI transaction id' : 'Enter the card slip number or last digits';
  if (p.mode === 'cash' && p.cash.trim() !== '' && Number(p.cash) < total) return 'The cash received is less than the amount due';
  return null;
}

export const toPaymentDetails = (p: PaymentState): PaymentDetails => ({
  mode: p.mode,
  reference: p.reference.trim() || undefined,
  amountReceived: p.mode === 'cash' && p.cash.trim() !== '' ? Number(p.cash) : undefined,
});

/** Payment mode, the reference that mode needs, and (for cash) the amount handed over with the change to give back. */
export function PaymentFields({ value, onChange, total, refund = false }: { value: PaymentState; onChange: (next: PaymentState) => void; total: number; refund?: boolean }) {
  const { currentStaff } = useHospitalStore();
  const received = value.cash.trim() === '' ? null : Number(value.cash);
  const change = value.mode === 'cash' && received != null && received >= total ? received - total : null;
  const short = value.mode === 'cash' && received != null && received < total;
  return (
    <div>
      <div className="field">
        <label>{refund ? 'Refund mode' : 'Payment mode'}</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {PAYMENT_MODES.map((m) => (
            <label key={m.value} className="row" style={{ border: `1px solid ${value.mode === m.value ? 'var(--brand)' : 'var(--border)'}`, background: value.mode === m.value ? 'var(--brand-soft)' : 'var(--surface)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>
              <input type="radio" name="payment-mode" style={{ width: 'auto' }} checked={value.mode === m.value} onChange={() => onChange({ ...value, mode: m.value })} />
              {m.label}
            </label>
          ))}
        </div>
      </div>
      <div className="two-col">
        <div className="field">
          <label>{value.mode === 'upi' ? 'UPI transaction id *' : value.mode === 'card' ? 'Card slip no. / last digits *' : 'Reference / note (optional)'}</label>
          <input value={value.reference} onChange={(e) => onChange({ ...value, reference: e.target.value })} placeholder={value.mode === 'upi' ? 'e.g. 4082 1190 7731' : value.mode === 'card' ? 'e.g. 4821' : ''} maxLength={60} />
        </div>
        {value.mode === 'cash' && !refund && (
          <div className="field">
            <label>Cash received (optional)</label>
            <input type="number" min={0} value={value.cash} onChange={(e) => onChange({ ...value, cash: e.target.value })} placeholder={String(total)} />
            {change != null && change > 0 && <div style={{ fontSize: 12.5, marginTop: 4 }}>Change to return: <b className="mono">{rupees(change)}</b></div>}
            {short && <div style={{ fontSize: 12.5, marginTop: 4, color: 'var(--danger)' }}>Less than the amount due.</div>}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Collected by <b>{currentStaff.name}</b>, recorded on the invoice and slips.</div>
    </div>
  );
}

// ---- Panel and discount -------------------------------------------------------------------------------------

export interface PricingState {
  panelId: string;
  beneficiaryId: string;
  discountOn: boolean;
  discountType: 'percent' | 'amount';
  discountValue: string;
  discountReason: string;
}
export const emptyPricing: PricingState = { panelId: '', beneficiaryId: '', discountOn: false, discountType: 'percent', discountValue: '', discountReason: '' };

export function toPricingChoice(p: PricingState): PricingChoice {
  return {
    panelId: p.panelId || null,
    beneficiaryId: p.beneficiaryId.trim() || undefined,
    discount: p.discountOn && Number(p.discountValue) > 0 ? { type: p.discountType, value: Number(p.discountValue), reason: p.discountReason.trim() } : null,
  };
}

/** Why billing cannot go ahead yet (a panel needs its card number, a discount needs a reason), or null. */
export function pricingProblem(p: PricingState, quote: Quote | null): string | null {
  if (quote?.panel?.requiresBeneficiaryId && p.beneficiaryId.trim().length < 3) return `Enter the ${quote.panel.code} beneficiary / card number`;
  if (p.discountOn) {
    if (!(Number(p.discountValue) > 0)) return 'Enter the discount';
    if (p.discountReason.trim().length < 3) return 'Give a reason for the discount';
  }
  return null;
}

/**
 * The panel (CGHS, DGHS ...) whose special rates apply, with the beneficiary's card number, and an optional discount. Discounts are for the
 * billing counter and administrators; the front desk can bill at standard or panel rates only.
 */
export function PricingFields({ value, onChange }: { value: PricingState; onChange: (next: PricingState) => void; quote?: Quote | null }) {
  const { panels, currentRole } = useHospitalStore();
  useRefresh(['panels']);
  const mayDiscount = currentRole === 'biller' || currentRole === 'admin';
  const active = panels.filter((p) => p.active);
  const panel = active.find((p) => p.id === value.panelId);

  return (
    <div>
      <div className="two-col">
        <div className="field">
          <label>Billing category</label>
          <select value={value.panelId} onChange={(e) => onChange({ ...value, panelId: e.target.value, beneficiaryId: '' })}>
            <option value="">Self-pay (standard rates)</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </select>
        </div>
        {panel && (
          <div className="field">
            <label>{panel.code} beneficiary / card no.{panel.requiresBeneficiaryId ? ' *' : ''}</label>
            <input value={value.beneficiaryId} onChange={(e) => onChange({ ...value, beneficiaryId: e.target.value })} maxLength={60} placeholder="Card or referral number" />
          </div>
        )}
      </div>
      {panel && !panel.hasSpecialRates && (
        <div className="drug-flags" style={{ marginBottom: 8 }}>
          <span className="badge warn">No special rates are set for {panel.code} yet: the standard fees apply. Ask an administrator to enter the panel's rates.</span>
        </div>
      )}

      {mayDiscount && (
        <div style={{ marginBottom: 8 }}>
          <label className="row" style={{ cursor: 'pointer', marginBottom: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={value.discountOn} onChange={(e) => onChange({ ...value, discountOn: e.target.checked })} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>Give a discount</span>
          </label>
          {value.discountOn && (
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ marginBottom: 0, width: 110 }}>
                <label>Type</label>
                <select value={value.discountType} onChange={(e) => onChange({ ...value, discountType: e.target.value as 'percent' | 'amount' })}>
                  <option value="percent">Percent %</option>
                  <option value="amount">Amount ₹</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0, width: 110 }}>
                <label>{value.discountType === 'percent' ? 'Percent' : 'Amount'}</label>
                <input type="number" min={0} value={value.discountValue} onChange={(e) => onChange({ ...value, discountValue: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
                <label>Reason *</label>
                <input value={value.discountReason} onChange={(e) => onChange({ ...value, discountReason: e.target.value })} maxLength={200} placeholder="e.g. Senior citizen, staff family" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- The quote ------------------------------------------------------------------------------------------------------

/** Prices what is on screen (the server's answer, or the demo's own), a moment after each change. Null while it cannot be priced. */
export function useQuote(input: { consultations?: ConsultationRequest[]; billIds?: string[] }, pricing: PricingChoice) {
  const { quoteOpd } = useHospitalStore();
  const [quote, setQuote] = useState<Quote | null>(null);
  const key = JSON.stringify([input, pricing]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      const q = await quoteOpd({ ...input, ...pricing });
      if (current) setQuote(q);
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // the key stands for the whole input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return quote;
}

/** The invoice as it would be: each doctor's fee at the rate charged, any discount, and what is to be paid. */
export function QuoteTable({ quote }: { quote: Quote | null }) {
  if (!quote) return <div className="empty-state">Choose a doctor to see the amount.</div>;
  return (
    <table className="table">
      <thead><tr><th>Doctor</th><th className="num">Standard fee</th><th className="num">Rate charged{quote.panel ? ` (${quote.panel.code})` : ''}</th><th className="num">Discount</th><th className="num">Net</th></tr></thead>
      <tbody>
        {quote.consultations.map((c, i) => (
          <tr key={i}>
            <td>{c.doctorName}<div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{c.department}</div></td>
            <td className="num mono">{rupees(c.standardFee)}</td>
            <td className="num mono">{rupees(c.rate)}</td>
            <td className="num mono">{c.discount > 0 ? `− ${rupees(c.discount)}` : '—'}</td>
            <td className="num mono">{rupees(c.net)}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={4} style={{ fontWeight: 600 }}>To pay</td>
          <td className="num mono" style={{ fontWeight: 700, fontSize: 15 }}>{rupees(quote.net)}</td>
        </tr>
      </tbody>
    </table>
  );
}

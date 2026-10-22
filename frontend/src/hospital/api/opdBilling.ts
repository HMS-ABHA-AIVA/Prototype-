import type { BillLineItem, Encounter } from '../types/index.ts';
import { api } from './client.ts';
import { toEncounter } from './clinical.ts';

/**
 * OPD billing: registration, then billing, then the queue. A patient may see several doctors in one visit (one per speciality): each is
 * its own consultation with its own fee, token and appointment slip. Billing a patient makes one OPD invoice (also the receipt) covering
 * the chosen doctors at the standard rates or a panel's special rates (CGHS, DGHS ...), less any discount, with the payment details.
 * Paying issues each doctor's token and puts the patient in each queue. Invoices can be looked up, reprinted, and cancelled with a refund.
 */
export type PaymentMode = 'cash' | 'upi' | 'card' | 'other';

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];
export const modeLabel = (mode: PaymentMode | null | undefined) => PAYMENT_MODES.find((m) => m.value === mode)?.label ?? '—';

/** What the hospital charges for an OPD consultation when a doctor has no fee of their own. */
export const STANDARD_OPD_FEE = 600;

// ---- Panels (CGHS, DGHS, ECHS, insurers ...) ------------------------------------------------------
export type PanelCategory = 'government' | 'insurance' | 'corporate' | 'other';

export interface Panel {
  id: string;
  code: string;
  name: string;
  category: PanelCategory;
  /** Percentage off the doctor's standard fee, when the panel has no rate for the department. */
  discountPct: number;
  /** One fee for every consultation, when the panel has no rate for the department. */
  flatFee: number | null;
  requiresBeneficiaryId: boolean;
  active: boolean;
  rates: { department: string; fee: number }[];
  /** False when nothing is set: billing would charge the standard fee. */
  hasSpecialRates: boolean;
}

export type PanelInput = Pick<Panel, 'code' | 'name' | 'category' | 'discountPct' | 'flatFee' | 'requiresBeneficiaryId' | 'active'>;

export const fetchPanels = (all = false) => api<Panel[]>(`/panels${all ? '?all=true' : ''}`);
export const createPanelApi = (input: PanelInput) => api<Panel>('/panels', { method: 'POST', body: input });
export const updatePanelApi = (id: string, input: Partial<PanelInput>) => api<Panel>(`/panels/${id}`, { method: 'PATCH', body: input });
export const savePanelRatesApi = (id: string, rates: Panel['rates']) => api<Panel>(`/panels/${id}/rates`, { method: 'PUT', body: { rates } });

// ---- Pricing: panel and discount ----------------------------------------------------------------------
export interface DiscountChoice { type: 'percent' | 'amount'; value: number; reason?: string }
export interface PricingChoice {
  panelId?: string | null;
  /** The panel's beneficiary / card / referral number. */
  beneficiaryId?: string;
  discount?: DiscountChoice | null;
}

export interface PricedLine {
  department: string;
  doctorName: string;
  standardFee: number;
  rate: number;
  discount: number;
  net: number;
  label: string;
  discountLabel: string | null;
}

export interface Quote {
  panel: { id: string; code: string; name: string; requiresBeneficiaryId: boolean; hasSpecialRates: boolean } | null;
  consultations: PricedLine[];
  gross: number;
  discount: number;
  net: number;
}

export interface ConsultationRequest { department: string; doctorId: string }

export const quoteApi = (input: PricingChoice & { consultations?: ConsultationRequest[]; billIds?: string[] }) =>
  api<Quote>('/opd-billing/quote', { method: 'POST', body: input });

// ---- Consultations waiting to pay ---------------------------------------------------------------------
export interface AwaitingOpdVisit {
  billId: string;
  billNo: string;
  encounterId: string;
  patientId: string;
  patientName: string;
  mrn: string;
  department: string;
  doctorId: string | null;
  doctorName: string | null;
  createdAt: string;
  items: BillLineItem[];
  total: number;
}

/** One doctor's appointment slip: what the patient takes to that doctor's consultation room. */
export interface AppointmentSlip {
  slipNo: string;
  receiptNo: string;
  billId: string;
  encounterId: string;
  patientId: string;
  patientName: string;
  mrn: string;
  age: number | null;
  gender: string;
  department: string;
  doctorName: string | null;
  doctorHprId: string | null;
  tokenNo: number | null;
  fee: number;
  paymentMode: PaymentMode | null;
  collectedByName: string;
  collectedAt: string;
}

// ---- Invoices ------------------------------------------------------------------------------------------------
export interface InvoiceLine { slipNo: string; label: string; amount: number }

export interface OpdInvoice {
  id: string;
  /** The invoice number, which is also the receipt number. */
  invoiceNo: string;
  status: 'paid' | 'cancelled';
  patientId: string;
  patientName: string;
  mrn: string;
  patientAge: number | null;
  patientGender: string;
  panelId: string | null;
  panelCode: string | null;
  panelName: string | null;
  beneficiaryId: string | null;
  lines: InvoiceLine[];
  /** At the rates charged (standard or panel), before any discount. */
  grossAmount: number;
  discountAmount: number;
  discountType: 'percent' | 'amount' | null;
  discountValue: number | null;
  discountReason: string | null;
  /** What the patient paid (after discount). */
  amount: number;
  mode: PaymentMode;
  reference: string | null;
  amountReceived: number | null;
  change: number | null;
  collectedByName: string;
  collectedAt: string;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  refundAmount: number | null;
  refundMode: PaymentMode | null;
  refundReference: string | null;
  slips: AppointmentSlip[];
}

export interface InvoiceFilter { from?: string; to?: string; status?: 'all' | 'paid' | 'cancelled'; search?: string }

export interface OpdInvoiceList {
  from: string;
  to: string;
  invoices: OpdInvoice[];
  totals: { count: number; paidCount: number; cancelledCount: number; collected: number; refunded: number; net: number; discounts: number; byMode: Record<PaymentMode, number> };
}

export interface PaymentDetails {
  mode: PaymentMode;
  /** UPI transaction id, card slip / last digits ... (required for UPI and card). */
  reference?: string;
  /** Cash handed over, so the change can be shown. */
  amountReceived?: number;
}

export interface CancelDetails {
  reason: string;
  /** Defaults to everything that was paid. */
  refundAmount?: number;
  /** Defaults to the mode it was paid in. */
  refundMode?: PaymentMode;
  refundReference?: string;
}

type EncounterDto = Parameters<typeof toEncounter>[0];

export const fetchAwaitingOpd = () => api<AwaitingOpdVisit[]>('/opd-billing');

export const fetchInvoices = (f: InvoiceFilter = {}) => {
  const q = new URLSearchParams();
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.status && f.status !== 'all') q.set('status', f.status);
  if (f.search?.trim()) q.set('search', f.search.trim());
  return api<OpdInvoiceList>(`/opd-billing/invoices${q.toString() ? `?${q}` : ''}`);
};

const paymentBody = (d: PaymentDetails) => ({ paymentMode: d.mode, reference: d.reference || undefined, amountReceived: d.amountReceived });
const pricingBody = (p: PricingChoice) => ({ panelId: p.panelId || undefined, beneficiaryId: p.beneficiaryId?.trim() || undefined, discount: p.discount || undefined });

export const registerConsultationsApi = async (patientId: string, consultations: ConsultationRequest[]): Promise<Encounter[]> =>
  (await api<{ encounters: EncounterDto[] }>('/opd-billing/visits', { method: 'POST', body: { patientId, consultations } })).encounters.map(toEncounter);

/** Bills registered consultations: one payment, one invoice, a token and slip per doctor. */
export const collectOpdPaymentApi = async (billIds: string[], details: PaymentDetails, pricing: PricingChoice = {}) => {
  const done = await api<{ invoice: OpdInvoice; encounters: EncounterDto[] }>('/opd-billing/collect', {
    method: 'POST',
    body: { billIds, ...pricingBody(pricing), ...paymentBody(details) },
  });
  return { invoice: done.invoice, encounters: done.encounters.map(toEncounter) };
};

/** OPD billing in one step: register for the chosen doctors, price, take payment, issue tokens and slips. */
export const createInvoiceApi = async (patientId: string, consultations: ConsultationRequest[], details: PaymentDetails, pricing: PricingChoice = {}) => {
  const done = await api<{ invoice: OpdInvoice; encounters: EncounterDto[] }>('/opd-billing/invoices', {
    method: 'POST',
    body: { patientId, consultations, ...pricingBody(pricing), ...paymentBody(details) },
  });
  return { invoice: done.invoice, encounters: done.encounters.map(toEncounter) };
};

export const cancelInvoiceApi = (id: string, details: CancelDetails) =>
  api<{ invoice: OpdInvoice }>(`/opd-billing/invoices/${id}/cancel`, { method: 'POST', body: details }).then((r) => r.invoice);

export const cancelOpdVisitApi = async (billId: string) =>
  toEncounter((await api<{ encounter: EncounterDto }>(`/opd-billing/${billId}/cancel`, { method: 'POST', body: {} })).encounter);

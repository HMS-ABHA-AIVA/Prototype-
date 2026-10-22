import { useEffect, useMemo, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { searchPatientsApi } from '../../api/clinical';
import { modeLabel, type AwaitingOpdVisit, type ConsultationRequest, type InvoiceFilter, type OpdInvoice } from '../../api/opdBilling';
import { ConsultationPicker } from '../../components/shared/ConsultationPicker';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { useRefresh } from '../../store/useRefresh';
import type { Patient } from '../../types';
import { DEPARTMENTS } from '../registration/departments';
import { NewRegistrationModal } from '../registration/NewRegistrationModal';
import { SlipsDialog } from './AppointmentSlips';
import {
  PaymentFields, PricingFields, QuoteTable, emptyPayment, emptyPricing, paymentProblem, pricingProblem, rupees, toPaymentDetails, toPricingChoice, useQuote,
} from './BillingFields';
import { InvoiceDialog } from './InvoiceDialog';

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, in this computer's own time zone
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const OPEN = ['awaiting_payment', 'waiting', 'in_consult'];

type Dialog =
  | { kind: 'register' }
  | { kind: 'bill'; patient: Patient }
  | { kind: 'collect'; visits: AwaitingOpdVisit[] }
  | { kind: 'invoice'; invoice: OpdInvoice }
  | { kind: 'slips'; invoice: OpdInvoice };

/**
 * OPD billing, on its own screen. Find the patient (or register them if they are new), choose the doctors, the billing category (self-pay or a
 * panel such as CGHS or DGHS) and any discount, take the payment, and the OPD invoice, each doctor's appointment slip and token are issued.
 * The invoices generated are listed below, to look up, reprint, or cancel with a refund.
 */
export function OpdBillingPage() {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useRefresh(['patients', 'encounters', 'staff', 'panels']);

  return (
    <>
      <div className="os-head">
        <div>
          <h1>OPD Billing</h1>
          <div className="sub">Find or register the patient, bill the doctors they need, and issue the invoice and appointment slips</div>
        </div>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'register' })}>+ Register new patient</button>
      </div>

      <StartBilling onBill={(patient) => setDialog({ kind: 'bill', patient })} onRegister={() => setDialog({ kind: 'register' })} />
      <AwaitingPayment onCollect={(visits) => setDialog({ kind: 'collect', visits })} />
      <InvoiceList onOpen={(invoice) => setDialog({ kind: 'invoice', invoice })} />

      {dialog?.kind === 'register' && (
        <NewRegistrationModal onClose={() => setDialog(null)} onRegistered={(patient) => setDialog({ kind: 'bill', patient })} />
      )}
      {dialog?.kind === 'bill' && (
        <NewBillingDialog patient={dialog.patient} onClose={() => setDialog(null)} onDone={(invoice) => setDialog({ kind: 'invoice', invoice })} />
      )}
      {dialog?.kind === 'collect' && (
        <CollectDialog visits={dialog.visits} onClose={() => setDialog(null)} onDone={(invoice) => setDialog({ kind: 'invoice', invoice })} />
      )}
      {dialog?.kind === 'invoice' && (
        <InvoiceDialog invoice={dialog.invoice} onClose={() => setDialog(null)} onSlips={(invoice) => setDialog({ kind: 'slips', invoice })} />
      )}
      {dialog?.kind === 'slips' && (
        <SlipsDialog invoice={dialog.invoice} onClose={() => setDialog(null)} onBack={() => setDialog({ kind: 'invoice', invoice: dialog.invoice })} />
      )}
    </>
  );
}

// ---- 1. Find the patient, or register ---------------------------------------------------------------------

function StartBilling({ onBill, onRegister }: { onBill: (patient: Patient) => void; onRegister: () => void }) {
  const { patients } = useHospitalStore();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Patient[] | null>(null);
  const text = query.trim();

  // With a backend the search runs on the server (any number of patients); in the demo it filters the patients on screen.
  useEffect(() => {
    if (text.length < 2) {
      setFound(null);
      return;
    }
    if (!apiEnabled) {
      const q = text.toLowerCase();
      setFound(patients.filter((p) => p.name.toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q) || p.phone.includes(q) || (p.abhaNumber ?? '').includes(q)).slice(0, 12));
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      searchPatientsApi(text).then((rows) => current && setFound(rows)).catch(() => current && setFound([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text, patients]);

  return (
    <div className="card">
      <h3>1. Find the patient</h3>
      <div className="card-sub">Search by name, MRN, mobile number or ABHA. A new patient is registered first, and billing starts straight after.</div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type at least 2 letters or digits…" style={{ maxWidth: 460 }} autoFocus />

      {found && found.length > 0 && (
        <table className="table" style={{ marginTop: 10 }}>
          <thead><tr><th>MRN</th><th>Patient</th><th>Age / Gender</th><th>Mobile</th><th>ABHA</th><th></th></tr></thead>
          <tbody>
            {found.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.mrn}</td>
                <td style={{ fontWeight: 500 }}>{p.name}</td>
                <td>{p.age} / {p.gender}</td>
                <td className="mono">{p.phone}</td>
                <td>{p.abhaStatus === 'linked' ? <Badge tone="ok">Linked</Badge> : <Badge tone="neutral">Not linked</Badge>}</td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-primary btn-sm" onClick={() => onBill(p)}>Start OPD billing →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {found && found.length === 0 && (
        <div className="empty-state" style={{ textAlign: 'left' }}>
          No patient found for “{text}”.{' '}
          <button className="btn btn-primary btn-sm" onClick={onRegister}>Register as a new patient →</button>
        </div>
      )}
    </div>
  );
}

// ---- Start billing for a patient ------------------------------------------------------------------------------

function NewBillingDialog({ patient, onClose, onDone }: { patient: Patient; onClose: () => void; onDone: (invoice: OpdInvoice) => void }) {
  const { staff, encounters, createOpdInvoice } = useHospitalStore();
  const doctors = staff.filter((s) => s.role === 'doctor');
  // Departments where this patient already has an open consultation cannot be billed again.
  const blocked = encounters.filter((e) => e.patientId === patient.id && e.type === 'OPD' && OPEN.includes(e.status)).map((e) => e.department);
  const firstFree = [...new Set([...DEPARTMENTS, ...doctors.map((d) => d.department)])].find((d) => !blocked.includes(d)) ?? DEPARTMENTS[0]!;

  const [rows, setRows] = useState<ConsultationRequest[]>([{ department: firstFree, doctorId: '' }]);
  const [pricing, setPricing] = useState(emptyPricing);
  const [payment, setPayment] = useState(emptyPayment);
  const [busy, setBusy] = useState(false);

  // With a backend the doctors arrive a moment after the dialog opens: fill in the first doctor once they do.
  useEffect(() => {
    setRows((current) => current.map((r) => (r.doctorId ? r : { ...r, doctorId: (doctors.find((d) => d.department === r.department) ?? doctors[0])?.id ?? '' })));
    // only when the list of doctors changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctors.length]);

  const choice = toPricingChoice(pricing);
  const quote = useQuote({ consultations: rows.filter((r) => r.doctorId) }, choice);
  const total = quote?.net ?? 0;
  const problem = rows.some((r) => !r.doctorId) ? 'Choose a doctor for each speciality' : !quote ? 'Cannot price this yet' : pricingProblem(pricing, quote) ?? paymentProblem(payment, total);

  async function bill() {
    if (busy || problem) return;
    setBusy(true);
    const invoice = await createOpdInvoice({ patientId: patient.id, consultations: rows, details: toPaymentDetails(payment), pricing: choice });
    setBusy(false);
    if (invoice) onDone(invoice);
  }

  return (
    <Modal title={`OPD billing · ${patient.name}`} onClose={onClose} width={820}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
        MRN <span className="mono">{patient.mrn}</span> · {patient.age} / {patient.gender} · {patient.phone}
        {blocked.length > 0 && <> · already open: <b>{[...new Set(blocked)].join(', ')}</b></>}
      </p>

      <h4 className="step-title">2. Doctors</h4>
      <ConsultationPicker value={rows} onChange={setRows} blocked={blocked} />

      <h4 className="step-title">3. Rates and discount</h4>
      <PricingFields value={pricing} onChange={setPricing} quote={quote} />
      <QuoteTable quote={quote} />

      <h4 className="step-title">4. Payment</h4>
      <PaymentFields value={payment} onChange={setPayment} total={total} />

      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={bill}>
          {busy ? 'Billing…' : `Collect ${rupees(total)} & generate invoice`}
        </button>
      </div>
      {problem && <div className="ai-hint" style={{ textAlign: 'right' }}>{problem}</div>}
    </Modal>
  );
}

// ---- 2. Registered, waiting to pay -------------------------------------------------------------------------------

function AwaitingPayment({ onCollect }: { onCollect: (visits: AwaitingOpdVisit[]) => void }) {
  const { opdBilling, patients, cancelOpdVisit } = useHospitalStore();
  useRefresh(['opdBilling'], 10);
  // Everything is ticked by default; this holds the ones the biller has un-ticked.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [addFor, setAddFor] = useState<Patient | null>(null);

  const byPatient = useMemo(() => {
    const groups = new Map<string, AwaitingOpdVisit[]>();
    for (const v of opdBilling) groups.set(v.patientId, [...(groups.get(v.patientId) ?? []), v]);
    return [...groups.values()];
  }, [opdBilling]);

  const toggle = (id: string) =>
    setUnticked((u) => {
      const next = new Set(u);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function cancel(visit: AwaitingOpdVisit) {
    if (!window.confirm(`Cancel ${visit.patientName}'s ${visit.department} consultation? No token will be issued and its fee bill is voided.`)) return;
    await cancelOpdVisit(visit.billId);
  }

  if (byPatient.length === 0) return null;
  return (
    <div className="card">
      <div className="flex-between">
        <div>
          <h3>Registered, waiting to pay</h3>
          <div className="card-sub">Patients the front desk has sent here. Take the payment to issue their invoice, tokens and appointment slips.</div>
        </div>
        <Badge tone="warn">{opdBilling.length} consultation{opdBilling.length === 1 ? '' : 's'} awaiting payment</Badge>
      </div>
      {byPatient.map((visits) => {
        const first = visits[0]!;
        const chosen = visits.filter((v) => !unticked.has(v.billId));
        const chosenTotal = chosen.reduce((sum, v) => sum + v.total, 0);
        return (
          <div key={first.patientId} className="opd-group">
            <div className="flex-between">
              <div><b>{first.patientName}</b> <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{first.mrn}</span></div>
              <button className="btn btn-ghost btn-sm" onClick={() => setAddFor(patients.find((p) => p.id === first.patientId) ?? null)}>+ Add doctor</button>
            </div>
            <table className="table">
              <tbody>
                {visits.map((v) => (
                  <tr key={v.billId}>
                    <td style={{ width: 28 }}><input type="checkbox" style={{ width: 'auto' }} checked={!unticked.has(v.billId)} onChange={() => toggle(v.billId)} aria-label={`Collect ${v.doctorName ?? v.department}`} /></td>
                    <td>{v.department}</td>
                    <td>{v.doctorName ?? '—'}</td>
                    <td className="mono" style={{ color: 'var(--ink-soft)' }}>{timeOf(v.createdAt)}</td>
                    <td className="num mono">{rupees(v.total)}</td>
                    <td style={{ width: 70 }}><button className="btn btn-ghost btn-sm" onClick={() => cancel(v)}>Cancel</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex-between">
              <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{chosen.length} of {visits.length} selected</span>
              <button className="btn btn-primary btn-sm" disabled={chosen.length === 0} onClick={() => onCollect(chosen)}>Bill selected · {rupees(chosenTotal)}</button>
            </div>
          </div>
        );
      })}
      {addFor && <AddDoctorsDialog patient={addFor} onClose={() => setAddFor(null)} />}
    </div>
  );
}

/** Registers more doctors for a patient who is already waiting here (they appear in the list, to be billed with the others). */
function AddDoctorsDialog({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const { registerConsultations, staff, encounters } = useHospitalStore();
  const doctors = staff.filter((s) => s.role === 'doctor');
  const blocked = encounters.filter((e) => e.patientId === patient.id && e.type === 'OPD' && OPEN.includes(e.status)).map((e) => e.department);
  const firstFree = [...new Set([...DEPARTMENTS, ...doctors.map((d) => d.department)])].find((d) => !blocked.includes(d)) ?? DEPARTMENTS[0]!;
  const [rows, setRows] = useState<ConsultationRequest[]>([{ department: firstFree, doctorId: (doctors.find((d) => d.department === firstFree) ?? doctors[0])?.id ?? '' }]);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (busy) return;
    setBusy(true);
    const made = await registerConsultations(patient.id, rows);
    setBusy(false);
    if (made) onClose();
  }

  return (
    <Modal title={`Add a doctor for ${patient.name}`} onClose={onClose} width={620}>
      <ConsultationPicker value={rows} onChange={setRows} blocked={blocked} />
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || rows.some((r) => !r.doctorId)} onClick={add}>{busy ? 'Adding…' : 'Add to this patient'}</button>
      </div>
    </Modal>
  );
}

function CollectDialog({ visits, onClose, onDone }: { visits: AwaitingOpdVisit[]; onClose: () => void; onDone: (invoice: OpdInvoice) => void }) {
  const { collectOpdPayment } = useHospitalStore();
  const [pricing, setPricing] = useState(emptyPricing);
  const [payment, setPayment] = useState(emptyPayment);
  const [busy, setBusy] = useState(false);
  const first = visits[0]!;

  const choice = toPricingChoice(pricing);
  const quote = useQuote({ billIds: visits.map((v) => v.billId) }, choice);
  const total = quote?.net ?? visits.reduce((sum, v) => sum + v.total, 0);
  const problem = !quote ? 'Cannot price this yet' : pricingProblem(pricing, quote) ?? paymentProblem(payment, total);

  async function collect() {
    if (busy || problem) return;
    setBusy(true);
    const invoice = await collectOpdPayment(visits.map((v) => v.billId), toPaymentDetails(payment), choice);
    setBusy(false);
    if (invoice) onDone(invoice);
  }

  return (
    <Modal title="OPD billing" onClose={onClose} width={780}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}><b>{first.patientName}</b> · <span className="mono">{first.mrn}</span></p>
      <PricingFields value={pricing} onChange={setPricing} quote={quote} />
      <QuoteTable quote={quote} />
      <PaymentFields value={payment} onChange={setPayment} total={total} />
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Back</button>
        <button className="btn btn-primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={collect}>
          {busy ? 'Billing…' : `Collect ${rupees(total)} & generate invoice`}
        </button>
      </div>
      {problem && <div className="ai-hint" style={{ textAlign: 'right' }}>{problem}</div>}
    </Modal>
  );
}

// ---- 3. Every invoice generated -----------------------------------------------------------------------------------

function InvoiceList({ onOpen }: { onOpen: (invoice: OpdInvoice) => void }) {
  const { opdInvoices, loadOpdInvoices } = useHospitalStore();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState<NonNullable<InvoiceFilter['status']>>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const run = () => void loadOpdInvoices({ from, to, status, search });
    const first = setTimeout(run, search ? 300 : 0);
    const poll = setInterval(() => { if (!document.hidden) run(); }, 20000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
    // the filters are the whole input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, status, search]);

  const totals = opdInvoices?.totals;
  return (
    <div className="card">
      <div className="flex-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3>OPD invoices</h3>
          <div className="card-sub">Every invoice generated, with how it was paid and by whom. Open one to view, reprint, or cancel with a refund.</div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Badge tone="ok">Collected {rupees(totals?.collected ?? 0)}</Badge>
          {(totals?.refunded ?? 0) > 0 && <Badge tone="danger">Refunded {rupees(totals!.refunded)}</Badge>}
          <Badge tone="info">Net {rupees(totals?.net ?? 0)}</Badge>
          {(totals?.discounts ?? 0) > 0 && <Badge tone="warn">Discounts {rupees(totals!.discounts)}</Badge>}
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', margin: '6px 0 10px', gap: 6 }}>
        <Badge tone="neutral">{totals?.paidCount ?? 0} paid · {totals?.cancelledCount ?? 0} cancelled</Badge>
        {(['cash', 'upi', 'card', 'other'] as const).map((m) => (totals?.byMode[m] ?? 0) !== 0 && <Badge key={m} tone="neutral">{modeLabel(m)} {rupees(totals!.byMode[m])}</Badge>)}
      </div>

      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All</option><option value="paid">Paid</option><option value="cancelled">Cancelled / refunded</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
          <label>Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice no., patient name, MRN or mobile" />
        </div>
      </div>

      <table className="table">
        <thead>
          <tr><th>Invoice</th><th>Time</th><th>Patient</th><th>Doctors (token)</th><th>Category</th><th className="num">Gross</th><th className="num">Discount</th><th className="num">Net</th><th>Payment</th><th>Billed by</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {(opdInvoices?.invoices ?? []).map((i) => (
            <tr key={i.id} className="clickable" onClick={() => onOpen(i)}>
              <td className="mono">{i.invoiceNo}</td>
              <td className="mono">{timeOf(i.collectedAt)}</td>
              <td><b>{i.patientName}</b><div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{i.mrn}</div></td>
              <td style={{ fontSize: 12.5 }}>{i.slips.map((s) => `${s.doctorName ?? s.department} (#${s.tokenNo ?? '—'})`).join(', ')}</td>
              <td>{i.panelCode ?? 'Self-pay'}</td>
              <td className="num mono">{rupees(i.grossAmount)}</td>
              <td className="num mono">{i.discountAmount > 0 ? rupees(i.discountAmount) : '—'}</td>
              <td className="num mono">{rupees(i.amount)}</td>
              <td>{modeLabel(i.mode)}{i.reference && <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{i.reference}</div>}</td>
              <td>{i.collectedByName}</td>
              <td>
                {i.status === 'paid' ? <Badge tone="ok">Paid</Badge> : <Badge tone="danger">Refunded {rupees(i.refundAmount ?? 0)}</Badge>}
              </td>
              <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpen(i); }}>View</button></td>
            </tr>
          ))}
          {(opdInvoices?.invoices.length ?? 0) === 0 && <tr><td colSpan={12} className="empty-state">No OPD invoices for these days and filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

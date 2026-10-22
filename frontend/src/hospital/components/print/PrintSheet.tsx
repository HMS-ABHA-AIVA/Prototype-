import type { ReactNode } from 'react';
import { Modal } from '../ui/Modal';
import { useFacility } from '../shared/useFacility';
import { useSettings } from '../shared/useSettings';

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const genderWord = (g: string | null | undefined) => (g === 'M' ? 'Male' : g === 'F' ? 'Female' : g ? 'Other' : '');
export const ageOf = (yearOfBirth: number | null | undefined) => (yearOfBirth ? `${new Date().getFullYear() - yearOfBirth} yrs` : '');

/**
 * A printable document in a dialog: the buttons on screen, then only the sheet when printed. The sheet starts with the hospital's own heading
 * (name, address, registration, GSTIN) so every document looks like it came from the hospital.
 */
export function PrintDialog({ title, onClose, children, width = 800, actions }: { title: string; onClose: () => void; children: ReactNode; width?: number; actions?: ReactNode }) {
  return (
    <Modal title={title} onClose={onClose} width={width}>
      <div className="rx-actions no-print">
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>🖨 Print</button>
        {actions}
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="print-area">{children}</div>
    </Modal>
  );
}

/** The hospital heading and the document's title. */
export function SheetHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const facility = useFacility();
  const settings = useSettings();
  const place = [facility?.address, facility?.district, facility?.state, facility?.pincode].filter(Boolean).join(', ');
  const contact = [facility?.phone && `Phone ${facility.phone}`, facility?.email].filter(Boolean).join(' · ');
  const ids = [settings?.registrationNo && `Reg. no. ${settings.registrationNo}`, settings?.gstin && `GSTIN ${settings.gstin}`].filter(Boolean).join(' · ');
  return (
    <div className="rx-head">
      <div className="rx-hospital">{facility?.name || 'AIVA OSHealth'}</div>
      {place && <div className="rx-small">{place}</div>}
      {contact && <div className="rx-small">{contact}</div>}
      {ids && <div className="rx-small">{ids}</div>}
      <div className="slip-title">{title}</div>
      {subtitle && <div className="rx-small">{subtitle}</div>}
    </div>
  );
}

/** The hospital's line at the foot of a printed document. */
export function SheetFooter({ extra }: { extra?: ReactNode }) {
  const settings = useSettings();
  return (
    <div className="rx-small" style={{ marginTop: 14 }}>
      {extra}
      {extra ? ' ' : ''}{settings?.billFooter ?? 'This is a computer generated document.'}
    </div>
  );
}

export function SignatureRow({ labels }: { labels: string[] }) {
  return (
    <div className="rx-sign">
      {labels.map((label) => <div key={label} className="rx-sign-line">{label}</div>)}
    </div>
  );
}

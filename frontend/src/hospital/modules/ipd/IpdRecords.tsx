import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import * as ipd from '../../api/ipd';
import { PrintDialog, SheetFooter, SheetHeader, SignatureRow, ageOf, genderWord, when } from '../../components/print/PrintSheet';
import { useSettings } from '../../components/shared/useSettings';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { useHospitalStore } from '../../store/useHospitalStore';
import type { Encounter, Patient } from '../../types';

// ---- Forms to print ----------------------------------------------------------------------------------------------------------

/** The admission form with the consent wording and places to sign. Filled in from the record, so nothing is written twice. */
export function AdmissionFormPrint({ running, patient, onClose }: { running: ipd.RunningBill; patient: Patient; onClose: () => void }) {
  const settings = useSettings();
  return (
    <PrintDialog title={`Admission form · ${patient.name}`} onClose={onClose}>
      <div className="rx-sheet">
        <SheetHeader title="ADMISSION FORM" />
        <table className="slip-table">
          <tbody>
            <tr><td>Patient</td><td><b>{patient.name}</b> · {[ageOf(running.patient.yearOfBirth), genderWord(patient.gender)].filter(Boolean).join(' · ')}</td></tr>
            <tr><td>MRN</td><td>{patient.mrn}{patient.abhaNumber ? ` · ABHA ${patient.abhaNumber}` : ''}</td></tr>
            <tr><td>Phone</td><td>{patient.phone || '—'}</td></tr>
            <tr><td>Admitted on</td><td>{when(running.admittedAt)}</td></tr>
            <tr><td>Ward / bed</td><td>{running.bed ? `${running.bed.ward} · ${running.bed.bedNo}` : '—'}</td></tr>
            <tr><td>Department / doctor</td><td>{running.department} · {running.doctorName ?? '—'}</td></tr>
            <tr><td>Billing category</td><td>{running.panel ? `${running.panel.name} (${running.panel.code})${running.beneficiaryId ? ` · card ${running.beneficiaryId}` : ''}` : 'Self-pay'}</td></tr>
            <tr><td>Known allergies</td><td>{patient.allergies.length ? <b>{patient.allergies.join(', ')}</b> : 'None recorded'}</td></tr>
            <tr><td>Known conditions</td><td>{patient.problemList?.length ? patient.problemList.join(', ') : 'None recorded'}</td></tr>
          </tbody>
        </table>
        <table className="slip-table" style={{ marginTop: 10 }}>
          <tbody>
            <tr><td>Name of relative / representative</td><td>&nbsp;</td></tr>
            <tr><td>Relationship, phone</td><td>&nbsp;</td></tr>
            <tr><td>Address</td><td>&nbsp;<br />&nbsp;</td></tr>
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <b>Consent for admission and treatment</b>
          <p style={{ marginTop: 6, textAlign: 'justify' }}>{settings?.consentText ?? 'I consent to the admission, examination, investigations and treatment advised by the hospital.'}</p>
        </div>
        <SignatureRow labels={['Patient / representative', 'Witness', 'Admitting doctor']} />
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

/** The discharge summary as the patient takes it home: who, when, what was done, the advice and the follow-up. */
export function DischargeSummaryPrint({ running, patient, encounter, onClose }: { running: ipd.RunningBill; patient: Patient; encounter: Encounter; onClose: () => void }) {
  const stayDays = running.admittedAt && running.dischargedAt ? Math.max(1, Math.ceil((new Date(running.dischargedAt).getTime() - new Date(running.admittedAt).getTime()) / 86400000)) : null;
  return (
    <PrintDialog title={`Discharge summary · ${patient.name}`} onClose={onClose}>
      <div className="rx-sheet">
        <SheetHeader title="DISCHARGE SUMMARY" />
        <div className="rx-meta">
          <div>
            <div><b>{patient.name}</b></div>
            <div>{[ageOf(running.patient.yearOfBirth), genderWord(patient.gender)].filter(Boolean).join(' · ')}</div>
            <div className="rx-small">MRN {patient.mrn}{patient.abhaNumber ? ` · ABHA ${patient.abhaNumber}` : ''}</div>
          </div>
          <div className="rx-right">
            <div className="rx-small">{running.bed ? `${running.bed.ward} ${running.bed.bedNo}` : ''} · {running.department}</div>
            <div className="rx-small">Admitted {when(running.admittedAt)}</div>
            <div className="rx-small">Discharged {when(running.dischargedAt)}{stayDays ? ` (${stayDays} day${stayDays === 1 ? '' : 's'})` : ''}</div>
            <div className="rx-small">Treating doctor: {running.doctorName ?? '—'}</div>
          </div>
        </div>
        {patient.allergies.length > 0 && <div className="rx-allergy">Allergy: {patient.allergies.join(', ')}</div>}
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, margin: '10px 0' }}>{encounter.dischargeSummary || 'The summary has not been signed off yet.'}</div>
        {encounter.prescriptions.length > 0 && (
          <>
            <b>Medicines given during the stay</b>
            <table className="rx-table" style={{ marginTop: 4 }}>
              <thead><tr><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Duration</th></tr></thead>
              <tbody>{encounter.prescriptions.map((rx) => <tr key={rx.id}><td>{rx.drugName}</td><td>{rx.dose}</td><td>{rx.frequency}</td><td>{rx.duration}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {encounter.orders.length > 0 && <div className="rx-small" style={{ marginBottom: 6 }}><b>Investigations:</b> {encounter.orders.map((o) => o.name).join(', ')}</div>}
        <SignatureRow labels={['Patient / representative', `${running.doctorName ?? 'Treating doctor'}`]} />
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

/** A newborn's birth notification, from what was recorded at the birth. Official registration of the birth is done separately with the municipal registrar. */
export function BirthCertificatePrint({ birth, onClose }: { birth: ipd.Birth; onClose: () => void }) {
  return (
    <PrintDialog title={`Birth ${birth.birthNo}`} onClose={onClose} width={680}>
      <div className="rx-sheet">
        <SheetHeader title="BIRTH CERTIFICATE (HOSPITAL COPY)" subtitle={`Birth register no. ${birth.birthNo}`} />
        <p style={{ margin: '10px 0' }}>This is to certify that a {birth.gender === 'M' ? 'male' : birth.gender === 'F' ? 'female' : ''} child was born at this hospital as recorded below.</p>
        <table className="slip-table">
          <tbody>
            <tr><td>Name of the child</td><td>{birth.babyName || <i>Not yet named</i>}</td></tr>
            <tr><td>Sex</td><td>{genderWord(birth.gender)}</td></tr>
            <tr><td>Date and time of birth</td><td><b>{when(birth.bornAt)}</b></td></tr>
            <tr><td>Weight at birth</td><td>{birth.weightGrams ? `${birth.weightGrams} g` : '—'}</td></tr>
            <tr><td>Type of delivery</td><td style={{ textTransform: 'capitalize' }}>{birth.deliveryType}</td></tr>
            <tr><td>Name of the mother</td><td><b>{birth.motherName}</b> · MRN {birth.motherMrn}</td></tr>
            <tr><td>Name of the father</td><td>{birth.fatherName || '—'}</td></tr>
            <tr><td>Attended by</td><td>{birth.attendedBy || '—'}</td></tr>
          </tbody>
        </table>
        <div className="rx-small" style={{ marginTop: 10 }}>This hospital record does not replace the registration of the birth with the local registrar of births and deaths, which the family must complete within the time the law allows.</div>
        <SignatureRow labels={['Doctor / nurse in charge', 'Medical superintendent']} />
        <SheetFooter />
      </div>
    </PrintDialog>
  );
}

// ---- Births ----------------------------------------------------------------------------------------------------------------------------

/** Newborns delivered during this admission, with the birth register number and a printable certificate. */
export function BirthsPanel({ encounterId }: { encounterId: string }) {
  const [births, setBirths] = useState<ipd.Birth[]>([]);
  const [adding, setAdding] = useState(false);
  const [printing, setPrinting] = useState<ipd.Birth | null>(null);
  const load = useCallback(() => { ipd.fetchBirths(encounterId).then(setBirths, reportError); }, [encounterId]);
  useEffect(load, [load]);

  return (
    <div className="card">
      <div className="flex-between">
        <div><h3>Births</h3><div className="card-sub">Newborns delivered during this stay</div></div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Register a newborn</button>
      </div>
      <table className="table">
        <thead><tr><th>Birth no.</th><th>Baby</th><th>Born</th><th>Weight</th><th>Delivery</th><th></th></tr></thead>
        <tbody>
          {births.map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.birthNo}</td><td>{b.babyName || `Baby of ${b.motherName}`} · {genderWord(b.gender)}</td><td>{when(b.bornAt)}</td>
              <td>{b.weightGrams ? `${b.weightGrams} g` : '—'}</td><td style={{ textTransform: 'capitalize' }}>{b.deliveryType}</td>
              <td><button className="btn btn-sm" onClick={() => setPrinting(b)}>🖨 Certificate</button></td>
            </tr>
          ))}
          {births.length === 0 && <tr><td colSpan={6} className="empty-state">No birth has been registered for this admission.</td></tr>}
        </tbody>
      </table>
      {adding && <BirthDialog encounterId={encounterId} onClose={() => setAdding(false)} onDone={(b) => { setAdding(false); load(); setPrinting(b); }} />}
      {printing && <BirthCertificatePrint birth={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function BirthDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: (b: ipd.Birth) => void }) {
  const { currentStaff } = useHospitalStore();
  const [gender, setGender] = useState<'M' | 'F' | 'O'>('F');
  const [bornAt, setBornAt] = useState(localInput(new Date()));
  const [weight, setWeight] = useState('');
  const [delivery, setDelivery] = useState<ipd.Birth['deliveryType']>('normal');
  const [baby, setBaby] = useState('');
  const [father, setFather] = useState('');
  const [attendedBy, setAttendedBy] = useState(currentStaff.role === 'doctor' ? currentStaff.name : '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ipd.recordBirth(encounterId, {
        gender, bornAt: new Date(bornAt).toISOString(), deliveryType: delivery,
        ...(weight.trim() ? { weightGrams: Math.round(Number(weight)) } : {}),
        ...(baby.trim() ? { babyName: baby.trim() } : {}), ...(father.trim() ? { fatherName: father.trim() } : {}),
        ...(attendedBy.trim() ? { attendedBy: attendedBy.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the birth');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Register a newborn" onClose={onClose} width={560}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="two-col">
          <div className="field"><label>Sex *</label><select value={gender} onChange={(e) => setGender(e.target.value as 'M' | 'F' | 'O')}><option value="F">Girl</option><option value="M">Boy</option><option value="O">Other</option></select></div>
          <div className="field"><label>Date and time of birth *</label><input type="datetime-local" value={bornAt} max={localInput(new Date())} onChange={(e) => setBornAt(e.target.value)} /></div>
        </div>
        <div className="two-col">
          <div className="field"><label>Weight (grams)</label><input type="number" min={300} max={8000} value={weight} onChange={(e) => setWeight(e.target.value)} /></div>
          <div className="field"><label>Type of delivery</label><select value={delivery} onChange={(e) => setDelivery(e.target.value as ipd.Birth['deliveryType'])}><option value="normal">Normal</option><option value="caesarean">Caesarean</option><option value="assisted">Assisted</option><option value="other">Other</option></select></div>
        </div>
        <div className="two-col">
          <div className="field"><label>Name of the baby (if named)</label><input value={baby} onChange={(e) => setBaby(e.target.value)} maxLength={120} /></div>
          <div className="field"><label>Father's name</label><input value={father} onChange={(e) => setFather(e.target.value)} maxLength={120} /></div>
        </div>
        <div className="field"><label>Attended by</label><input value={attendedBy} onChange={(e) => setAttendedBy(e.target.value)} maxLength={120} /></div>
        <div className="field"><label>Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Register birth'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Documents -------------------------------------------------------------------------------------------------------------------------

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Scanned consents, outside reports and scans attached to this stay. They open in a new tab and are removed only with a reason (the record stays). */
export function DocumentsPanel({ encounterId }: { encounterId: string }) {
  const role = useHospitalStore((s) => s.currentRole);
  const [docs, setDocs] = useState<ipd.EncounterDocument[]>([]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ipd.EncounterDocument | null>(null);
  const load = useCallback(() => { ipd.fetchDocuments(encounterId).then(setDocs, reportError); }, [encounterId]);
  useEffect(load, [load]);

  const open = async (d: ipd.EncounterDocument) => {
    try { await ipd.openDocument(d.id); } catch (err) { reportError(err); }
  };

  return (
    <div className="card">
      <div className="flex-between">
        <div><h3>Documents</h3><div className="card-sub">Signed consents, outside reports and scans for this stay (PDF, PNG, JPEG or WEBP, up to 10 MB)</div></div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Attach a document</button>
      </div>
      <table className="table">
        <thead><tr><th>Title</th><th>Kind</th><th>Size</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td><b>{d.title}</b><div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{d.fileName}</div></td>
              <td><Badge tone="neutral">{ipd.DOCUMENT_KIND_LABEL[d.kind]}</Badge></td><td>{size(d.sizeBytes)}</td>
              <td>{when(d.uploadedAt)}<div className="rx-small" style={{ color: 'var(--ink-soft)' }}>{d.uploadedBy}</div></td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-sm" onClick={() => open(d)}>Open</button>
                {(role === 'doctor' || role === 'admin') && <button className="btn btn-sm btn-ghost" onClick={() => setRemoving(d)}>Remove</button>}
              </div></td>
            </tr>
          ))}
          {docs.length === 0 && <tr><td colSpan={5} className="empty-state">No documents attached.</td></tr>}
        </tbody>
      </table>
      {adding && <UploadDialog encounterId={encounterId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); useNoticeStore.getState().show('Document attached', 'info'); }} />}
      {removing && (
        <Modal title="Remove this document" onClose={() => setRemoving(null)} width={460}>
          <RemoveForm onCancel={() => setRemoving(null)} onConfirm={async (reason) => { await ipd.removeDocument(removing.id, reason); setRemoving(null); load(); }} />
        </Modal>
      )}
    </div>
  );
}

function RemoveForm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await onConfirm(reason.trim()); } catch (err) { setError(err instanceof Error ? err.message : 'Could not remove'); setBusy(false); } }}>
      {error && <div className="login-error" role="alert">{error}</div>}
      <div className="field"><label>Reason *</label><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus placeholder="e.g. Attached to the wrong patient" /></div>
      <div className="ai-hint">The document disappears from the list. The file and this reason stay on record for the audit trail.</div>
      <div className="flex-between" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Back</button>
        <button className="btn btn-primary" disabled={busy || reason.trim().length < 3}>{busy ? 'Removing…' : 'Remove'}</button>
      </div>
    </form>
  );
}

function UploadDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<ipd.DocumentKind>('consent');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooBig = !!file && file.size > 10 * 1024 * 1024;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy || tooBig || title.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await ipd.uploadDocument(encounterId, file, { kind, title: title.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Attach a document" onClose={onClose} width={500}>
      <form onSubmit={submit}>
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="field">
          <label>File *</label>
          <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '')); }} />
          {tooBig && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>That file is larger than 10 MB.</div>}
        </div>
        <div className="two-col">
          <div className="field"><label>Title *</label><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Surgical consent" /></div>
          <div className="field"><label>Kind</label><select value={kind} onChange={(e) => setKind(e.target.value as ipd.DocumentKind)}>{(Object.keys(ipd.DOCUMENT_KIND_LABEL) as ipd.DocumentKind[]).map((k) => <option key={k} value={k}>{ipd.DOCUMENT_KIND_LABEL[k]}</option>)}</select></div>
        </div>
        <div className="flex-between" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !file || tooBig || title.trim().length < 2}>{busy ? 'Uploading…' : 'Attach'}</button>
        </div>
      </form>
    </Modal>
  );
}


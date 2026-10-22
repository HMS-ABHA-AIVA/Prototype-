import { useCallback, useEffect, useRef, useState } from 'react';
import * as lab from '../../api/lab';
import { FLAG_LABEL, STATUS_LABEL, STATUS_TONE } from '../../api/lab';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { ageOf, genderWord, when } from '../../components/print/PrintSheet';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { ReasonDialog } from '../ipdbilling/IpdBillDialogs';
import { ReportDialog } from './LabReport';
import { flagColor, flagFor, rangeText } from './labFlags';

interface EntryRow {
  parameterId: string | null;
  name: string;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  value: string;
  abnormal: boolean;
  custom: boolean;
}

const toRows = (form: lab.FormRow[]): EntryRow[] => form.map((f) => ({ ...f, abnormal: f.flag === 'abnormal', custom: f.parameterId === null }));

/**
 * One test's work in a dialog, whatever stage it is at: collect the sample (or start the study), enter the results (or write the report),
 * sign it, and afterwards read it or amend it. The server decides what is allowed; this only shows what can be done next.
 */
export function WorkDialog({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const [order, setOrder] = useState<lab.OrderDetail | null>(null);
  const [rows, setRows] = useState<EntryRow[]>([]);
  const [remarks, setRemarks] = useState('');
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [report, setReport] = useState(false);
  const fileBox = useRef<HTMLInputElement>(null);

  const adopt = useCallback((o: lab.OrderDetail) => {
    setOrder(o);
    setRows(toRows(o.form));
    setRemarks(o.remarks ?? '');
    setFindings(o.findings ?? '');
    setImpression(o.impression ?? '');
  }, []);
  useEffect(() => { lab.fetchOrder(orderId).then(adopt, (err) => setError(err instanceof Error ? err.message : 'Could not open the test')); }, [orderId, adopt]);

  if (!order) return <Modal title="Test" onClose={onClose} width={460}>{error ? <div className="login-error" role="alert">{error}</div> : <div className="empty-state">Loading…</div>}</Modal>;

  const isLab = order.kind === 'lab';
  const editable = isLab ? order.status === 'sample_collected' || order.status === 'resulted' : order.status === 'in_progress' || order.status === 'resulted';
  const notice = (text: string) => useNoticeStore.getState().show(text, 'info');

  /** Runs one step, refreshes the dialog, and tells the worklist. A refusal from the server is shown in the dialog. */
  const step = async (work: () => Promise<lab.OrderDetail>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      adopt(await work());
      if (done) notice(done);
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    isLab
      ? lab.saveResults(order.id, rows.filter((r) => r.value.trim()).map((r) => ({ ...(r.parameterId ? { parameterId: r.parameterId } : { name: r.name }), value: r.value, ...(r.abnormal ? { abnormal: true } : {}) })), remarks)
      : lab.saveWrittenReport(order.id, findings, impression);

  const saveAndSign = async () => {
    setBusy(true);
    setError(null);
    try {
      await save();
      adopt(await lab.signReport(order.id));
      notice('Report signed and released');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  /** Only the list of images is refreshed: what has been typed into the form and not yet saved must stay. */
  const refreshImages = async () => { const fresh = await lab.fetchOrder(order.id); setOrder({ ...order, attachments: fresh.attachments }); };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await lab.uploadAttachment(order.id, file, file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'Image');
      await refreshImages();
      notice('Image attached');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed');
    } finally {
      setBusy(false);
      if (fileBox.current) fileBox.current.value = '';
    }
  };

  const setRow = (i: number, change: Partial<EntryRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const anyValue = rows.some((r) => r.value.trim());

  return (
    <Modal title={`${order.name}${order.accessionNo ? ` · ${order.accessionNo}` : ''}`} onClose={onClose} width={860}>
      {error && <div className="login-error" role="alert">{error}</div>}
      <div className="flex-between" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
        <div>
          <b>{order.patientName}</b> <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>· {[ageOf(order.yearOfBirth), genderWord(order.gender)].filter(Boolean).join(' · ')} · MRN {order.mrn}</span>
          <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>
            Ordered {when(order.createdAt)}{order.orderedBy ? ` by ${order.orderedBy}` : ''}{order.invoiceNo ? ` · lab invoice ${order.invoiceNo}` : order.department ? ` · ${order.encounterType} ${order.department}` : ''}
            {order.sample ? ` · sample: ${order.sample}` : ''}{order.tatHours != null ? ` · report in ${order.tatHours} h` : ''}
          </div>
        </div>
        <div><Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>{order.overdue && <> <Badge tone="danger">Overdue</Badge></>}{order.critical && <> <Badge tone="danger">Critical value</Badge></>}</div>
      </div>
      {order.collectedAt && <div className="rx-small" style={{ marginBottom: 8, color: 'var(--ink-soft)' }}>{isLab ? 'Sample collected' : 'Study started'} {when(order.collectedAt)} by {order.collectedBy}{order.sampleNote ? ` · ${order.sampleNote}` : ''}</div>}
      {order.status === 'ordered' && order.sampleNote && <div className="rx-small" style={{ marginBottom: 8, color: 'var(--danger)' }}>{order.sampleNote}</div>}

      {order.status === 'ordered' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-primary" disabled={busy} onClick={() => step(() => lab.collect(order.id), isLab ? 'Sample collected' : 'Study started')}>{isLab ? 'Collect sample' : 'Start study'}</button>
          <button className="btn btn-ghost" onClick={() => setAsking('cancel')}>Cancel this test</button>
        </div>
      )}

      {order.status === 'cancelled' && <div className="empty-state">Cancelled by {order.cancelledBy ?? 'staff'}: {order.cancelReason}</div>}

      {editable && isLab && (
        <>
          <table className="table">
            <thead><tr><th>Test</th><th style={{ width: 150 }}>Result</th><th>Unit</th><th>Normal range</th><th style={{ width: 54 }}>Flag</th><th style={{ width: 60 }}>Abn.</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const flag = r.value.trim() ? flagFor(r.value, r, r.abnormal) : null;
                return (
                  <tr key={r.parameterId ?? `custom-${i}`}>
                    <td>{r.custom ? <input value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="Name" maxLength={80} /> : r.name}</td>
                    <td><input className="mono" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} maxLength={120} style={{ borderColor: flagColor(flag), fontWeight: flag && flag !== 'normal' ? 700 : 400 }} /></td>
                    <td>{r.unit ?? ''}</td>
                    <td className="rx-small">{rangeText(r)}</td>
                    <td style={{ fontWeight: 700, color: flagColor(flag) }}>{flag ? FLAG_LABEL[flag] : ''}</td>
                    <td><input type="checkbox" style={{ width: 'auto' }} checked={r.abnormal} onChange={(e) => setRow(i, { abnormal: e.target.checked })} aria-label={`Mark ${r.name} abnormal`} /></td>
                    <td>{r.custom && <button className="btn btn-ghost btn-sm" aria-label="Remove row" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="empty-state">This test has no list of measures. Add what was measured below.</td></tr>}
            </tbody>
          </table>
          <button className="btn btn-sm" onClick={() => setRows([...rows, { parameterId: null, name: rows.length === 0 ? order.name : '', unit: null, refLow: null, refHigh: null, refText: null, criticalLow: null, criticalHigh: null, value: '', abnormal: false, custom: true }])}>+ Add a result row</button>
          <div className="field" style={{ marginTop: 10 }}><label>Remarks (optional)</label><input value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={1000} placeholder="e.g. sample slightly haemolysed" /></div>
          <div className="rx-small" style={{ color: 'var(--ink-soft)' }}>Write "-" for a measure that was not done. A result with a number is checked against the normal range; text ("Nil", "Positive") is flagged only if you tick Abn.</div>
        </>
      )}

      {editable && !isLab && (
        <>
          <div className="field"><label>Findings *</label><textarea rows={7} value={findings} onChange={(e) => setFindings(e.target.value)} maxLength={6000} autoFocus /></div>
          <div className="field"><label>Impression *</label><textarea rows={3} value={impression} onChange={(e) => setImpression(e.target.value)} maxLength={2000} /></div>
          <div className="field">
            <label>Images and files</label>
            {order.attachments.map((a) => (
              <div key={a.id} className="row" style={{ marginBottom: 4 }}>
                <button className="btn btn-sm" onClick={() => lab.openAttachment(a.id).catch(reportError)}>🖼 {a.title}</button>
                <span className="rx-small" style={{ color: 'var(--ink-soft)' }}>{Math.round(a.sizeBytes / 1024)} KB · {a.uploadedBy}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setAsking(`remove-${a.id}`)}>Remove</button>
              </div>
            ))}
            <input ref={fileBox} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <div className="ai-hint">PDF, PNG, JPEG or WEBP, up to 10 MB. Where the hospital's file storage is not set up yet, saving an image is refused.</div>
          </div>
        </>
      )}

      {editable && (
        <div className="flex-between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
          <div className="row">
            {isLab && order.status === 'sample_collected' && <button className="btn btn-ghost" onClick={() => setAsking('reject')}>Reject sample</button>}
            {order.status !== 'resulted' && <button className="btn btn-ghost" onClick={() => setAsking('cancel')}>Cancel this test</button>}
          </div>
          <div className="row">
            <button className="btn" disabled={busy || (isLab ? !anyValue : findings.trim().length < 3 || impression.trim().length < 3)} onClick={() => step(save, isLab ? 'Results saved' : 'Report saved')}>Save</button>
            <button className="btn btn-primary" disabled={busy || (isLab ? !anyValue : findings.trim().length < 3 || impression.trim().length < 3)} onClick={saveAndSign}>Save &amp; sign report</button>
          </div>
        </div>
      )}
      {editable && order.status === 'resulted' && order.amendedCount > 0 && <div className="rx-small" style={{ marginTop: 8, color: 'var(--warn)' }}>This report is being amended (the earlier version is kept).</div>}

      {order.status === 'completed' && (
        <>
          {isLab ? (
            <table className="table">
              <thead><tr><th>Test</th><th className="num">Result</th><th></th><th>Unit</th><th>Normal range</th></tr></thead>
              <tbody>
                {order.results.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td><td className="num mono" style={{ color: flagColor(r.flag), fontWeight: r.flag && r.flag !== 'normal' ? 700 : 400 }}>{r.valueText}</td>
                    <td style={{ fontWeight: 700, color: flagColor(r.flag) }}>{r.flag ? FLAG_LABEL[r.flag] : ''}</td><td>{r.unit ?? ''}</td><td className="rx-small">{rangeText(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>Findings</div><div style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>{order.findings}</div>
              <div style={{ fontWeight: 600 }}>Impression</div><div style={{ whiteSpace: 'pre-wrap' }}>{order.impression}</div>
            </div>
          )}
          {order.remarks && <div style={{ fontSize: 13, marginTop: 6 }}><b>Remarks:</b> {order.remarks}</div>}
          <div className="rx-small" style={{ marginTop: 8, color: 'var(--ink-soft)' }}>
            Entered by {order.resultedBy} · signed {when(order.signedAt)} by {order.signedBy}
            {order.critical && (order.criticalAckAt ? ` · critical value acknowledged by ${order.criticalAckBy}` : ' · critical value not yet acknowledged by a doctor')}
          </div>
          {order.amendments.map((a) => <div key={a.id} className="rx-small" style={{ color: 'var(--ink-soft)' }}>Amended {when(a.amendedAt)} by {a.amendedBy}: {a.reason}</div>)}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={() => setReport(true)}>View / print report</button>
            <button className="btn" onClick={() => setAsking('amend')}>Amend…</button>
          </div>
        </>
      )}

      {report && <ReportDialog orderId={order.id} onClose={() => setReport(false)} onChanged={() => { onChanged(); lab.fetchOrder(order.id).then(adopt, reportError); }} />}
      {asking === 'reject' && <ReasonDialog title="Reject the sample" prompt="Why is the sample not usable? *" confirmLabel="Reject sample" onClose={() => setAsking(null)} onConfirm={async (reason) => { adopt(await lab.rejectSample(order.id, reason)); setAsking(null); onChanged(); }} />}
      {asking === 'cancel' && <ReasonDialog title="Cancel this test" prompt="Reason for cancelling *" confirmLabel="Cancel the test" onClose={() => setAsking(null)} onConfirm={async (reason) => { adopt(await lab.cancelTest(order.id, reason)); setAsking(null); onChanged(); }} />}
      {asking === 'amend' && <ReasonDialog title="Amend the signed report" prompt="What is being corrected, and why? *" confirmLabel="Reopen for correction" onClose={() => setAsking(null)} onConfirm={async (reason) => { adopt(await lab.amendReport(order.id, reason)); setAsking(null); onChanged(); }} />}
      {asking?.startsWith('remove-') && (
        <ReasonDialog
          title="Remove the image" prompt="Why is it being removed? *" confirmLabel="Remove"
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => { await lab.removeAttachment(asking.slice(7), reason); await refreshImages(); setAsking(null); }}
        />
      )}
    </Modal>
  );
}

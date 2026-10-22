import { useEffect, useState } from 'react';
import * as lab from '../../api/lab';
import { Badge } from '../../components/ui/Badge';
import { PrintDialog, SheetFooter, SheetHeader, ageOf, genderWord, when } from '../../components/print/PrintSheet';
import { Modal } from '../../components/ui/Modal';
import { useHospitalStore } from '../../store/useHospitalStore';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { FLAG_LABEL } from '../../api/lab';
import { flagColor, rangeText } from './labFlags';

/** The signed report on paper: hospital heading, patient and sample details, each result against its normal range with the flag, and who signed it. */
function ReportSheet({ report }: { report: lab.Report }) {
  const isLab = report.kind === 'lab';
  return (
    <div className="rx-sheet">
      <SheetHeader title={isLab ? 'Laboratory Report' : 'Radiology Report'} subtitle={report.section ?? undefined} />
      <table className="rx-meta" style={{ width: '100%', fontSize: 12.5, marginBottom: 8 }}>
        <tbody>
          <tr>
            <td><b>{report.patientName}</b> · {[ageOf(report.yearOfBirth), genderWord(report.gender)].filter(Boolean).join(' · ')}</td>
            <td style={{ textAlign: 'right' }}>MRN <b className="mono">{report.mrn}</b></td>
          </tr>
          <tr>
            <td>{isLab ? 'Sample no.' : 'Accession no.'} <b className="mono">{report.accessionNo ?? '—'}</b>{report.sample ? ` · ${report.sample}` : ''}</td>
            <td style={{ textAlign: 'right' }}>{report.invoiceNo ? `Invoice ${report.invoiceNo}` : [report.encounterType, report.department].filter(Boolean).join(' · ')}</td>
          </tr>
          <tr>
            <td>{isLab ? 'Collected' : 'Done'}: {when(report.collectedAt)}</td>
            <td style={{ textAlign: 'right' }}>Reported: {when(report.signedAt)}</td>
          </tr>
          {(report.orderedBy || report.referredBy) && <tr><td colSpan={2}>Referred by: {report.orderedBy ?? report.referredBy}</td></tr>}
        </tbody>
      </table>

      <div style={{ fontWeight: 700, fontSize: 14, margin: '10px 0 4px' }}>{report.name}{report.amendedCount > 0 && <span style={{ marginLeft: 8 }}><Badge tone="warn">Amended report</Badge></span>}</div>

      {isLab ? (
        <table className="table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>Test</th><th className="num">Result</th><th></th><th>Unit</th><th>Normal range</th></tr></thead>
          <tbody>
            {report.results.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num mono" style={{ fontWeight: r.flag && r.flag !== 'normal' ? 700 : 400, color: flagColor(r.flag) }}>{r.valueText}</td>
                <td style={{ fontWeight: 700, color: flagColor(r.flag) }}>{r.flag ? FLAG_LABEL[r.flag] : ''}</td>
                <td>{r.unit ?? ''}</td>
                <td>{rangeText(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>Findings</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: 8 }}>{report.findings}</div>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>Impression</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{report.impression}</div>
        </>
      )}
      {isLab && <div className="rx-small" style={{ marginTop: 4 }}>L = low, H = high, LL / HH = critical, Abn = abnormal.</div>}
      {isLab && report.remarks && <div style={{ fontSize: 13, marginTop: 8 }}><b>Remarks:</b> {report.remarks}</div>}
      {report.amendments.length > 0 && (
        <div className="rx-small" style={{ marginTop: 8 }}>
          {report.amendments.map((a) => <div key={a.id}>Amended {when(a.amendedAt)} by {a.amendedBy}: {a.reason}</div>)}
        </div>
      )}

      <div className="rx-sign" style={{ marginTop: 28 }}>
        <div className="rx-sign-line">Entered by {report.resultedBy ?? '—'}</div>
        <div className="rx-sign-line">
          {report.signer ? <>{report.signer.name}{report.signer.hprId ? ` (${report.signer.hprId})` : ''}</> : report.signedBy}
          <div className="rx-small">Signed {when(report.signedAt)}</div>
        </div>
      </div>
      <SheetFooter extra="This report is valid only with the signature above. Please correlate with the clinical findings." />
    </div>
  );
}

/** Opens a signed report by the order's id. A doctor can acknowledge a critical value from here. */
export function ReportDialog({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged?: () => void }) {
  const [report, setReport] = useState<lab.Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const role = useHospitalStore((s) => s.currentRole);
  const load = () => { lab.fetchReport(orderId).then(setReport, (err) => setError(err instanceof Error ? err.message : 'Could not open the report')); };
  useEffect(load, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Modal title="Report" onClose={onClose} width={460}><div className="login-error" role="alert">{error}</div><button className="btn" onClick={onClose}>Close</button></Modal>;
  if (!report) return <Modal title="Report" onClose={onClose} width={460}><div className="empty-state">Loading…</div></Modal>;

  const mustAck = report.critical && !report.criticalAckAt && (role === 'doctor' || role === 'admin');
  const acknowledge = async () => {
    try {
      await lab.acknowledgeCritical(orderId);
      useNoticeStore.getState().show('Critical value acknowledged', 'info');
      load();
      onChanged?.();
    } catch (err) {
      reportError(err);
    }
  };
  const attachments = report.attachments;
  return (
    <PrintDialog
      title={`${report.name} · ${report.patientName}`}
      onClose={onClose}
      width={820}
      actions={
        <>
          {mustAck && <button className="btn btn-sm btn-primary" onClick={acknowledge}>I have seen the critical value</button>}
          {attachments.map((a) => <button key={a.id} className="btn btn-sm" onClick={() => lab.openAttachment(a.id).catch(reportError)}>🖼 {a.title}</button>)}
        </>
      }
    >
      {report.critical && (
        <div className="login-error no-print" role="alert" style={{ marginBottom: 8 }}>
          This report has a <b>critical value</b>.{report.criticalAckAt ? ` Acknowledged by ${report.criticalAckBy}.` : ' It has not been acknowledged by a doctor yet.'}
        </div>
      )}
      <ReportSheet report={report} />
    </PrintDialog>
  );
}

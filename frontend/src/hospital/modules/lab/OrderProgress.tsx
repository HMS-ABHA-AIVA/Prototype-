import { useState } from 'react';
import { apiEnabled } from '../../api/client';
import { STATUS_LABEL, STATUS_TONE } from '../../api/lab';
import { Badge } from '../../components/ui/Badge';
import type { Order } from '../../types';
import { ReportDialog } from './LabReport';

/**
 * Where a test order has got to, for the doctor's screens: waiting, sample taken, awaiting signature, or the report itself (with a warning
 * when it holds a critical value that nobody has acknowledged). Without the backend it keeps the plain badge of the stand-alone demo.
 */
export function OrderProgress({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  if (!apiEnabled) return <Badge tone={order.status === 'completed' ? 'ok' : 'warn'}>{order.status}</Badge>;
  const waitingForAck = order.critical && !order.criticalAckAt;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
      {order.accessionNo && <span className="mono rx-small" style={{ color: 'var(--ink-soft)' }}>{order.accessionNo}</span>}
      {order.status === 'completed' && (
        <>
          <button className="btn btn-sm" onClick={() => setOpen(true)}>View report</button>
          {waitingForAck && <Badge tone="danger">Critical value</Badge>}
        </>
      )}
      {open && <ReportDialog orderId={order.id} onClose={() => setOpen(false)} />}
    </span>
  );
}

import type { AuditEntry } from '../types/index.ts';
import { api } from './client.ts';

interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

/** The audit trail (administrators only), newest first, in the shape the Audit screen uses. */
export async function fetchAudit(limit = 200): Promise<AuditEntry[]> {
  const rows = await api<AuditRow[]>(`/audit-log?limit=${limit}`);
  return rows.map((r) => ({ id: String(r.id), at: r.at, user: r.actor, action: r.action, detail: r.detail }));
}

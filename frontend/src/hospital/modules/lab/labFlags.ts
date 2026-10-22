import type { Flag } from '../../api/lab';

/**
 * The same check the server makes, so the person entering a result sees the flag at once. The server decides the saved flag.
 * A text result ("Nil") has no number to check, so it is flagged only if the person marks it abnormal.
 */
export interface Limits { refLow: number | null; refHigh: number | null; criticalLow: number | null; criticalHigh: number | null }

const NUMBER = /^[-+]?\d+(\.\d+)?$/;
export const numberOf = (text: string): number | null => (NUMBER.test(text.trim()) ? Number(text.trim()) : null);

export function flagFor(text: string, limits: Limits, markedAbnormal = false): Flag | null {
  const value = numberOf(text);
  let flag: Flag | null = null;
  if (value !== null) {
    if (limits.criticalLow !== null && value < limits.criticalLow) flag = 'critical_low';
    else if (limits.criticalHigh !== null && value > limits.criticalHigh) flag = 'critical_high';
    else if (limits.refLow !== null && value < limits.refLow) flag = 'low';
    else if (limits.refHigh !== null && value > limits.refHigh) flag = 'high';
    else if (limits.refLow !== null || limits.refHigh !== null) flag = 'normal';
  }
  if (markedAbnormal && (flag === null || flag === 'normal')) return 'abnormal';
  return flag;
}

/** "12 – 16", "up to 5", "from 3", or the text range ("Nil"). */
export function rangeText(p: { refLow: number | null; refHigh: number | null; refText: string | null }): string {
  if (p.refLow !== null && p.refHigh !== null) return `${p.refLow} – ${p.refHigh}`;
  if (p.refHigh !== null) return `up to ${p.refHigh}`;
  if (p.refLow !== null) return `from ${p.refLow}`;
  return p.refText ?? '';
}

export const flagColor = (flag: Flag | null): string | undefined =>
  flag === 'critical_low' || flag === 'critical_high' ? 'var(--danger)' : flag === 'low' || flag === 'high' || flag === 'abnormal' ? 'var(--warn, #b45309)' : undefined;

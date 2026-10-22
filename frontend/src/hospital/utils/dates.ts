const DAY_MS = 86_400_000;

/** Today's calendar date in the user's local timezone, as YYYY-MM-DD. */
export function todayLocal(): string {
  return localDateOf(new Date());
}

/** Calendar date of an instant in the user's local timezone, as YYYY-MM-DD (never via toISOString, which is UTC). */
export function localDateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isToday(iso: string): boolean {
  return localDateOf(new Date(iso)) === todayLocal();
}

/** Current month as YYYY-MM. */
export function currentMonth(): string {
  return todayLocal().slice(0, 7);
}

// ---- Seed-data re-anchoring -------------------------------------------------
// The demo data was authored as if "today" were SEED_ANCHOR. Shifting every date
// by the gap to the real today keeps the demo looking current whenever it is opened.

const SEED_ANCHOR = '2026-09-23';
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T|$)/;
// Dates that are meant to be absolute, not "relative to today".
const ABSOLUTE_KEYS = new Set(['expiry', 'dateOfJoining']);

function utcMs(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function mondayMs(ms: number): number {
  const dow = new Date(ms).getUTCDay();
  return ms - ((dow + 6) % 7) * DAY_MS;
}

/** Whole days between the seed's "today" and the real today. */
export const DAY_SHIFT = Math.round((utcMs(todayLocal()) - utcMs(SEED_ANCHOR)) / DAY_MS);

/** Same gap rounded to whole weeks, so weekdays line up (used for the roster). */
export const WEEK_SHIFT = (mondayMs(utcMs(todayLocal())) - mondayMs(utcMs(SEED_ANCHOR))) / DAY_MS;

export function shiftDateString(s: string, days: number): string {
  return new Date(utcMs(s) + days * DAY_MS).toISOString().slice(0, 10) + s.slice(10);
}

/** Deep-copies seed data, moving every date/timestamp string forward by `days`. */
export function shiftSeed<T>(value: T, days: number = DAY_SHIFT): T {
  if (typeof value === 'string') return (DATE_RE.test(value) ? shiftDateString(value, days) : value) as T;
  if (Array.isArray(value)) return value.map((v) => shiftSeed(v, days)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, ABSOLUTE_KEYS.has(k) ? v : shiftSeed(v, days)])
    ) as T;
  }
  return value;
}

/**
 * Medicine prices in India are the MRP, which already includes GST. So a sale line's total is what the patient pays, and it splits into a taxable
 * value and the tax: taxable = total / (1 + rate), tax = total - taxable. (Everything else on a hospital bill is priced before tax; a medicine's line
 * on a bill is therefore entered at its taxable value so the bill's total comes back to the MRP.)
 */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PricedLine {
  lineTotal: number;
  taxable: number;
  tax: number;
}

/** What a quantity at an MRP comes to after a percentage discount, and how that splits into taxable value and GST. */
export function priceLine(qty: number, mrp: number, gstPct: number, discountPct = 0): PricedLine {
  const lineTotal = round2(qty * mrp * (1 - discountPct / 100));
  const taxable = round2(lineTotal / (1 + gstPct / 100));
  return { lineTotal, taxable, tax: round2(lineTotal - taxable) };
}

/** Intra-state supply: the tax is shared equally between the Centre and the State (CGST and SGST). */
export function splitTax(tax: number): { cgst: number; sgst: number } {
  const cgst = round2(tax / 2);
  return { cgst, sgst: round2(tax - cgst) };
}

/** The Indian calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** The instant a given Indian date begins. */
export const istStart = (date: string) => new Date(`${date}T00:00:00+05:30`);
/** The instant just after a given Indian date ends. */
export const istEnd = (date: string) => new Date(istStart(date).getTime() + 86_400_000);

/**
 * How many units a prescription line comes to, when it can be worked out: frequency (OD, BD, TDS, QID, HS or 1-0-1) times the days of the duration.
 * Null when it cannot (as needed, "ongoing", unreadable): the pharmacist then enters the quantity.
 */
export function suggestedQuantity(frequency: string, duration: string): number | null {
  const f = frequency.trim().toUpperCase().replace(/\./g, "");
  let perDay: number | null = null;
  if (/^(OD|QD|HS|QHS|ONCE)/.test(f)) perDay = 1;
  else if (/^(BD|BID|TWICE)/.test(f)) perDay = 2;
  else if (/^(TDS|TID|THRICE)/.test(f)) perDay = 3;
  else if (/^(QID|QDS)/.test(f)) perDay = 4;
  else if (/^\d(-\d){1,3}$/.test(f)) perDay = f.split("-").reduce((sum, d) => sum + Number(d), 0);
  const match = /(\d+)\s*(day|week|month)/i.exec(duration);
  if (!perDay || !match) return null;
  const days = Number(match[1]) * (match[2]!.toLowerCase() === "week" ? 7 : match[2]!.toLowerCase() === "month" ? 30 : 1);
  return perDay * days > 0 && perDay * days <= 1000 ? perDay * days : null;
}

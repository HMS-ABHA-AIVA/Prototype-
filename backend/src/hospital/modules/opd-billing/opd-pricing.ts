import { badRequest } from "../../shared/errors.js";

/**
 * What an OPD consultation costs: the doctor's standard fee, or the special rate of a panel (CGHS, DGHS, ECHS, an insurer ...), less a
 * discount if the billing counter gives one. Pure functions, so the rules can be read and tested without a database.
 */
export interface PanelPricing {
  id: string;
  code: string;
  name: string;
  /** Percentage taken off the doctor's standard fee, when the panel has no fixed rate for the department. */
  discountPct: number;
  /** One fee for every consultation, when the panel has no rate for the department. */
  flatFee: number | null;
  /** Department (lower-case) -> the panel's agreed fee for it. */
  rates: Record<string, number>;
}

export interface ConsultationToPrice {
  department: string;
  doctorName: string;
  standardFee: number;
}
export interface DiscountInput {
  type: "percent" | "amount";
  value: number;
  reason?: string | null | undefined;
}

export interface PricedConsultation {
  department: string;
  doctorName: string;
  standardFee: number;
  /** What is charged before any discount: the standard fee, or the panel's rate. */
  rate: number;
  /** This consultation's share of the discount. */
  discount: number;
  net: number;
  label: string;
  discountLabel: string | null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** The panel's fee for a consultation: its rate for the department, else its flat fee, else the standard fee less its discount. */
export function panelRate(panel: PanelPricing, department: string, standardFee: number): number {
  const byDepartment = panel.rates[department.trim().toLowerCase()];
  if (byDepartment !== undefined) return byDepartment;
  if (panel.flatFee !== null) return panel.flatFee;
  return round2(standardFee * (1 - panel.discountPct / 100));
}

export function describeDiscount(discount: DiscountInput): string {
  const amount = discount.type === "percent" ? `${discount.value}%` : `Rs ${discount.value}`;
  return `Discount (${amount})${discount.reason?.trim() ? `: ${discount.reason.trim()}` : ""}`;
}

export function priceConsultations(items: ConsultationToPrice[], panel: PanelPricing | null, discount: DiscountInput | null) {
  const base = panel ? `OPD Consultation Fee (${panel.code})` : "OPD Consultation Fee";
  const rates = items.map((c) => (panel ? panelRate(panel, c.department, c.standardFee) : c.standardFee));
  const gross = round2(rates.reduce((sum, r) => sum + r, 0));

  let totalDiscount = 0;
  if (discount) {
    if (!(discount.value > 0)) throw badRequest("A discount must be more than zero");
    if (discount.type === "percent" && discount.value > 100) throw badRequest("A discount cannot be more than 100%");
    totalDiscount = discount.type === "percent" ? round2((gross * discount.value) / 100) : round2(discount.value);
    if (totalDiscount > gross) throw badRequest(`The discount (Rs ${totalDiscount}) is more than the amount to bill (Rs ${gross})`);
  }

  // Share the discount out in proportion to each consultation's rate; the last takes whatever is left so the shares add up exactly.
  let left = totalDiscount;
  const consultations: PricedConsultation[] = items.map((c, i) => {
    const last = i === items.length - 1;
    const share = !discount || gross === 0 ? 0 : last ? left : Math.min(left, round2((totalDiscount * rates[i]!) / gross));
    left = round2(left - share);
    return {
      department: c.department,
      doctorName: c.doctorName,
      standardFee: c.standardFee,
      rate: rates[i]!,
      discount: share,
      net: round2(rates[i]! - share),
      label: `${base}: ${c.doctorName} (${c.department})`,
      discountLabel: share > 0 && discount ? describeDiscount(discount) : null,
    };
  });
  return { consultations, gross, discount: totalDiscount, net: round2(gross - totalDiscount) };
}

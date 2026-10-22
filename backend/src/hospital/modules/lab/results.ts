import type { Queryable } from "../../db.js";
import { badRequest } from "../../shared/errors.js";

/**
 * Lab results. Each value is checked against the normal range the test was set up with and flagged low, high, or critical (beyond the critical
 * limits). A text result ("Nil", "Positive") has no number to check, so it is flagged only if the person entering it says it is abnormal.
 */
export type Flag = "normal" | "low" | "high" | "critical_low" | "critical_high" | "abnormal";

export interface Limits {
  refLow: number | null;
  refHigh: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
}

const NUMBER = /^[-+]?\d+(\.\d+)?$/;

/** The number in a result, or null when it is text ("Nil", "<0.5", "Reactive"). */
export const numberOf = (text: string): number | null => (NUMBER.test(text.trim()) ? Number(text.trim()) : null);

export function flagFor(value: number | null, limits: Limits, markedAbnormal = false): Flag | null {
  let flag: Flag | null = null;
  if (value !== null) {
    if (limits.criticalLow !== null && value < limits.criticalLow) flag = "critical_low";
    else if (limits.criticalHigh !== null && value > limits.criticalHigh) flag = "critical_high";
    else if (limits.refLow !== null && value < limits.refLow) flag = "low";
    else if (limits.refHigh !== null && value > limits.refHigh) flag = "high";
    else if (limits.refLow !== null || limits.refHigh !== null) flag = "normal";
  }
  if (markedAbnormal && (flag === null || flag === "normal")) return "abnormal";
  return flag;
}

export const isCritical = (flag: Flag | null) => flag === "critical_low" || flag === "critical_high";

export interface ResultRow {
  id: string;
  parameterId: string | null;
  name: string;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  valueText: string;
  valueNum: number | null;
  flag: Flag | null;
  sortOrder: number;
}

export const RESULT_COLUMNS = `id, "parameterId", name, unit, "refLow"::float8 AS "refLow", "refHigh"::float8 AS "refHigh", "refText", "criticalLow"::float8 AS "criticalLow",
  "criticalHigh"::float8 AS "criticalHigh", "valueText", "valueNum"::float8 AS "valueNum", flag, "sortOrder"`;

export const loadResults = (db: Queryable, orderId: string) =>
  db.query<ResultRow>(`SELECT ${RESULT_COLUMNS} FROM "OrderResult" WHERE "facilityId" = :fid AND "orderId" = $1 ORDER BY "sortOrder", name`, [orderId]);

interface MasterParameter extends Limits {
  id: string;
  name: string;
  unit: string | null;
  refText: string | null;
  sortOrder: number;
}

export const loadParameters = (db: Queryable, investigationId: string | null) =>
  investigationId
    ? db.query<MasterParameter>(
        `SELECT id, name, unit, "refLow"::float8 AS "refLow", "refHigh"::float8 AS "refHigh", "refText", "criticalLow"::float8 AS "criticalLow",
                "criticalHigh"::float8 AS "criticalHigh", "sortOrder"
           FROM "InvestigationParameter" WHERE "facilityId" = :fid AND "investigationId" = $1 ORDER BY "sortOrder", name`,
        [investigationId],
      )
    : Promise.resolve([] as MasterParameter[]);

/** True when a saved result is the value of this master parameter (by id, or by name after the test was edited and its parameters re-created). */
export const isResultOf = (r: Pick<ResultRow, "parameterId" | "name">, p: Pick<MasterParameter, "id" | "name">) =>
  r.parameterId === p.id || (r.parameterId === null && r.name.trim().toLowerCase() === p.name.trim().toLowerCase());

export interface ResultInput {
  parameterId?: string | undefined;
  name?: string | undefined;
  value: string;
  abnormal?: boolean | undefined;
}

/**
 * Replaces the results of a lab order with the values given (blank values are left out). The definition of each measure (unit, normal range,
 * critical limits) is copied in, so the report never changes if the test's ranges are edited later. Returns whether any value is critical.
 */
export async function saveResults(tx: Queryable, orderId: string, investigationId: string | null, input: ResultInput[]): Promise<{ count: number; critical: boolean }> {
  const params = await loadParameters(tx, investigationId);
  const rows: { p: MasterParameter | null; name: string; value: string; abnormal: boolean }[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const value = item.value.trim();
    if (!value) continue;
    let p: MasterParameter | null = null;
    if (item.parameterId) {
      p = params.find((x) => x.id === item.parameterId) ?? null;
      if (!p) throw badRequest("One of the results is for a test parameter that does not belong to this test");
    }
    const name = (p?.name ?? item.name ?? "").trim();
    if (!name) throw badRequest("Each result needs a name");
    const key = name.toLowerCase();
    if (seen.has(key)) throw badRequest(`${name} is entered twice`);
    seen.add(key);
    rows.push({ p, name, value, abnormal: item.abnormal === true });
  }
  if (rows.length === 0) throw badRequest("Enter at least one result");

  await tx.execute('DELETE FROM "OrderResult" WHERE "facilityId" = :fid AND "orderId" = $1', [orderId]);
  let critical = false;
  let order = 0;
  for (const r of rows) {
    const limits: Limits = r.p ?? { refLow: null, refHigh: null, criticalLow: null, criticalHigh: null };
    const num = numberOf(r.value);
    const flag = flagFor(num, limits, r.abnormal);
    if (isCritical(flag)) critical = true;
    await tx.execute(
      `INSERT INTO "OrderResult" ("facilityId", "orderId", "parameterId", name, unit, "refLow", "refHigh", "refText", "criticalLow", "criticalHigh", "valueText", "valueNum", flag, "sortOrder")
       VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [orderId, r.p?.id ?? null, r.name, r.p?.unit ?? null, limits.refLow, limits.refHigh, r.p?.refText ?? null, limits.criticalLow, limits.criticalHigh, r.value, num, flag, order++],
    );
  }
  return { count: rows.length, critical };
}

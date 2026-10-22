import type { Database, Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";

/** Salaried pay is a share of the monthly salary over this many working days. */
export const WORKING_DAYS_PER_MONTH = 26;

export type PayrollStatus = "draft" | "finalized" | "paid";

export interface PayrollLine {
  staffId: string;
  staffName: string;
  role: string;
  employmentType: "salaried" | "visiting_fee";
  daysPresent: number;
  doubleShiftDays: number;
  workingDays: number;
  consultCount: number;
  grossPay: number;
  deductions: number;
  netPay: number;
}

export interface PayrollRunSummary {
  id: string;
  month: string;
  status: PayrollStatus;
  generatedAt: string;
  generatedBy: string;
  staffCount: number;
  totalGross: number;
  totalNet: number;
}

export type PayrollRun = Omit<PayrollRunSummary, "staffCount" | "totalGross" | "totalNet"> & { lines: PayrollLine[]; totalGross: number; totalNet: number };

// ---- The pay rules (pure, so they are easy to read and test) ---------------------------------------

export interface ShiftRecord {
  date: string;
  status: "present" | "absent" | "leave" | "half_day";
}

/**
 * Attendance is recorded per shift, so a date with more than one shift marked present is a double shift and earns
 * more than one day's credit. A present shift counts 1, a half-day 0.5, absence and leave 0. If no attendance was
 * recorded at all for the month, a full month is assumed (so payroll can still run before attendance is entered).
 */
export function salariedAttendance(records: ShiftRecord[], monthlySalary: number) {
  const creditByDate = new Map<string, number>();
  for (const r of records) {
    const credit = r.status === "present" ? 1 : r.status === "half_day" ? 0.5 : 0;
    creditByDate.set(r.date, (creditByDate.get(r.date) ?? 0) + credit);
  }
  const daysPresent = records.length ? [...creditByDate.values()].reduce((sum, c) => sum + c, 0) : WORKING_DAYS_PER_MONTH;
  const doubleShiftDays = [...creditByDate.values()].filter((c) => c > 1).length;
  const grossPay = Math.round((monthlySalary * daysPresent) / WORKING_DAYS_PER_MONTH);
  return { daysPresent, doubleShiftDays, grossPay };
}

// ---- Database access ----------------------------------------------------------------------------

const LINE_COLUMNS = `"staffId", "staffName", role, "employmentType", "daysPresent", "doubleShiftDays", "workingDays",
  "consultCount", "grossPay", deductions, "netPay"`;

const sum = (lines: PayrollLine[], key: "grossPay" | "netPay") => lines.reduce((total, l) => total + l[key], 0);

export async function listRuns(db: Queryable): Promise<PayrollRunSummary[]> {
  return db.query<PayrollRunSummary>(
    `SELECT r.id, r.month, r.status, r."generatedAt", r."generatedBy", count(l."staffId")::int AS staff_count,
            COALESCE(sum(l."grossPay"), 0) AS total_gross, COALESCE(sum(l."netPay"), 0) AS total_net
       FROM "PayrollRun" r LEFT JOIN "PayrollLine" l ON l."runId" = r.id
      WHERE r."facilityId" = :fid
      GROUP BY r.id ORDER BY r.month DESC`,
  );
}

export async function getRun(db: Queryable, id: string): Promise<PayrollRun> {
  const run = await db.queryOne<Omit<PayrollRun, "lines" | "totalGross" | "totalNet">>(
    'SELECT id, month, status, "generatedAt", "generatedBy" FROM "PayrollRun" WHERE "facilityId" = :fid AND id = $1',
    [id],
  );
  if (!run) throw notFound("Payroll run");
  const lines = await db.query<PayrollLine>(`SELECT ${LINE_COLUMNS} FROM "PayrollLine" WHERE "facilityId" = :fid AND "runId" = $1 ORDER BY "staffName"`, [id]);
  return { ...run, lines, totalGross: sum(lines, "grossPay"), totalNet: sum(lines, "netPay") };
}

/** Calculates every active staff member's pay for the month and saves it as a draft run. */
export async function generateRun(db: Database, month: string, actor: string): Promise<PayrollRun> {
  return db.transaction(async (tx) => {
    if (await tx.queryOne('SELECT 1 FROM "PayrollRun" WHERE "facilityId" = :fid AND month = $1', [month])) {
      throw conflict(`A payroll run for ${month} already exists. Delete the draft first to generate it again.`);
    }
    const run = await tx.queryOne<{ id: string }>(`INSERT INTO "PayrollRun" ("facilityId", month, "generatedBy") VALUES (:fid, $1,$2) RETURNING id`, [month, actor]);

    const staff = await tx.query<{ id: string; name: string; role: string; employmentType: "salaried" | "visiting_fee"; monthlySalary: number | null; feePerConsult: number | null }>(
      `SELECT id, name, role::text AS role, "employmentType"::text AS "employmentType", "monthlySalary", "feePerConsult"
         FROM "Staff" WHERE "facilityId" = :fid AND active ORDER BY name`,
    );
    // Visiting doctors are paid per finished OPD consultation, counted in the hospital's own calendar month (IST).
    const consults = await tx.query<{ doctorId: string; n: number }>(
      `SELECT "doctorId", count(*)::int AS n FROM "Encounter"
        WHERE "facilityId" = :fid AND type = 'OPD' AND status IN ('closed','billed') AND "doctorId" IS NOT NULL
          AND to_char("createdAt" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1
        GROUP BY "doctorId"`,
      [month],
    );
    const consultsBy = new Map(consults.map((c) => [c.doctorId, c.n]));
    const attendance = await tx.query<ShiftRecord & { staffId: string }>(
      `SELECT "staffId", date, status FROM "Attendance" WHERE "facilityId" = :fid AND to_char(date, 'YYYY-MM') = $1`,
      [month],
    );
    const attendanceBy = new Map<string, ShiftRecord[]>();
    for (const a of attendance) attendanceBy.set(a.staffId, [...(attendanceBy.get(a.staffId) ?? []), a]);

    for (const member of staff) {
      let line: Pick<PayrollLine, "daysPresent" | "doubleShiftDays" | "workingDays" | "consultCount" | "grossPay">;
      if (member.employmentType === "visiting_fee") {
        const consultCount = consultsBy.get(member.id) ?? 0;
        line = { daysPresent: 0, doubleShiftDays: 0, workingDays: 0, consultCount, grossPay: Math.round(consultCount * (member.feePerConsult ?? 0)) };
      } else {
        const s = salariedAttendance(attendanceBy.get(member.id) ?? [], member.monthlySalary ?? 0);
        line = { ...s, workingDays: WORKING_DAYS_PER_MONTH, consultCount: 0 };
      }
      await tx.execute(
        `INSERT INTO "PayrollLine" ("facilityId", "runId", "staffId", "staffName", role, "employmentType", "daysPresent", "doubleShiftDays",
                                    "workingDays", "consultCount", "grossPay", deductions, "netPay")
         VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$10)`,
        [run!.id, member.id, member.name, member.role, member.employmentType, line.daysPresent, line.doubleShiftDays, line.workingDays, line.consultCount, line.grossPay],
      );
    }
    await recordAudit(tx, actor, "Payroll Run Generated", `${month} — ${staff.length} staff`);
    return getRun(tx, run!.id);
  });
}

const lockRun = (tx: Queryable, id: string) =>
  tx.queryOne<{ id: string; month: string; status: PayrollStatus }>('SELECT id, month, status FROM "PayrollRun" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE', [id]);

/** Sets what is deducted from one person's pay (advances, tax, ...). Only while the run is still a draft. */
export async function setDeduction(db: Database, runId: string, staffId: string, deductions: number, actor: string): Promise<PayrollRun> {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (!run) throw notFound("Payroll run");
    if (run.status !== "draft") throw conflict(`The ${run.month} run is ${run.status}; deductions can only change on a draft`);
    const line = await tx.queryOne<{ staffName: string; grossPay: number }>(
      'SELECT "staffName", "grossPay" FROM "PayrollLine" WHERE "facilityId" = :fid AND "runId" = $1 AND "staffId" = $2 FOR UPDATE',
      [runId, staffId],
    );
    if (!line) throw notFound("Payroll line");
    if (deductions > line.grossPay) throw badRequest(`Deductions (${deductions}) cannot exceed gross pay (${line.grossPay})`);
    await tx.execute('UPDATE "PayrollLine" SET deductions = $3, "netPay" = "grossPay" - $3 WHERE "facilityId" = :fid AND "runId" = $1 AND "staffId" = $2', [runId, staffId, deductions]);
    await recordAudit(tx, actor, "Payroll Deduction Set", `${run.month} — ${line.staffName}: ${deductions}`);
    return getRun(tx, runId);
  });
}

async function moveRun(db: Database, id: string, from: PayrollStatus, to: PayrollStatus, action: string, actor: string): Promise<PayrollRun> {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, id);
    if (!run) throw notFound("Payroll run");
    if (run.status !== from) throw conflict(`The ${run.month} run is ${run.status}; only a ${from} run can be moved to ${to}`);
    await tx.execute('UPDATE "PayrollRun" SET status = $2 WHERE "facilityId" = :fid AND id = $1', [id, to]);
    await recordAudit(tx, actor, action, run.month);
    return getRun(tx, id);
  });
}

export const finalizeRun = (db: Database, id: string, actor: string) => moveRun(db, id, "draft", "finalized", "Payroll Run Finalized", actor);
export const markRunPaid = (db: Database, id: string, actor: string) => moveRun(db, id, "finalized", "paid", "Payroll Run Marked Paid", actor);

/** A draft can be thrown away and generated again (for example after correcting attendance). */
export async function deleteDraftRun(db: Database, id: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const run = await lockRun(tx, id);
    if (!run) throw notFound("Payroll run");
    if (run.status !== "draft") throw conflict(`The ${run.month} run is ${run.status} and cannot be deleted`);
    await tx.execute('DELETE FROM "PayrollRun" WHERE "facilityId" = :fid AND id = $1', [id]);
    await recordAudit(tx, actor, "Payroll Draft Deleted", run.month);
  });
}

/** True when a finalized or paid run exists for the month: its attendance is then locked. */
export async function monthIsLocked(db: Queryable, month: string): Promise<boolean> {
  return !!(await db.queryOne(`SELECT 1 FROM "PayrollRun" WHERE "facilityId" = :fid AND month = $1 AND status <> 'draft'`, [month]));
}

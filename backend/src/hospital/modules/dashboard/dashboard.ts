import { Router } from "express";
import type { HospitalContext } from "../../context.js";

/**
 * The operational headline numbers on the home screen (the ABHA numbers come from GET /api/dashboard). Open to every
 * signed-in role: counts only, no patient details.
 */
export interface DashboardSummary {
  opdWaiting: number;
  /** OPD visits registered but not yet paid for (they join the queue after payment). */
  opdAwaitingPayment: number;
  erActive: number;
  erRedTriage: number;
  bedsTotal: number;
  bedsOccupied: number;
  /** whole percent, 0 when there are no beds */
  occupancyPct: number;
  patients: number;
  abhaLinkedPct: number;
  draftBills: number;
  lowStockDrugs: number;
  lowStockSupplies: number;
  wasteAwaitingDisposal: number;
  /** Lab and radiology tests not yet reported, and critical results nobody has acknowledged. */
  labPending: number;
  criticalResults: number;
}

export function dashboardRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const row = (await db.queryOne<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM "Encounter" WHERE "facilityId" = :fid AND type = 'OPD' AND status = 'waiting')::int           AS opd_waiting,
         (SELECT count(*) FROM "Encounter" WHERE "facilityId" = :fid AND type = 'OPD' AND status = 'awaiting_payment')::int  AS opd_awaiting_payment,
         (SELECT count(*) FROM "Encounter" WHERE "facilityId" = :fid AND type = 'ER'  AND status = 'in_er')::int             AS er_active,
         (SELECT count(*) FROM "Encounter" WHERE "facilityId" = :fid AND type = 'ER'  AND status = 'in_er' AND "triageLevel" = 'red')::int AS er_red_triage,
         (SELECT count(*) FROM "Bed" WHERE "facilityId" = :fid)::int                                                         AS beds_total,
         (SELECT count(*) FROM "Bed" WHERE "facilityId" = :fid AND status = 'occupied')::int                                 AS beds_occupied,
         (SELECT count(*) FROM "Patient" WHERE "facilityId" = :fid)::int                                                     AS patients,
         (SELECT count(*) FROM "Patient" p JOIN "AbhaPatient" a ON a."patientId" = p.id WHERE p."facilityId" = :fid)::int    AS abha_linked,
         (SELECT count(*) FROM "Bill" WHERE "facilityId" = :fid AND status = 'draft')::int                                   AS draft_bills,
         (SELECT count(*) FROM "Drug" d WHERE d."facilityId" = :fid AND COALESCE((SELECT sum(qty) FROM "DrugBatch" b
             WHERE b."facilityId" = :fid AND b."drugId" = d.id AND b.expiry >= (now() AT TIME ZONE 'Asia/Kolkata')::date), 0) <= d."reorderLevel")::int AS low_stock_drugs,
         (SELECT count(*) FROM "Supply" WHERE "facilityId" = :fid AND stock <= "reorderLevel")::int                          AS low_stock_supplies,
         (SELECT count(*) FROM "WasteBatch" WHERE "facilityId" = :fid AND stage <> 'disposed')::int                          AS waste_awaiting_disposal,
         (SELECT count(*) FROM "ClinicalOrder" WHERE "facilityId" = :fid AND status NOT IN ('completed', 'cancelled'))::int  AS lab_pending,
         (SELECT count(*) FROM "ClinicalOrder" WHERE "facilityId" = :fid AND critical AND "criticalAckAt" IS NULL AND status = 'completed')::int AS critical_results`,
    ))!;

    const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
    const summary: DashboardSummary = {
      opdWaiting: row.opdWaiting!,
      opdAwaitingPayment: row.opdAwaitingPayment!,
      erActive: row.erActive!,
      erRedTriage: row.erRedTriage!,
      bedsTotal: row.bedsTotal!,
      bedsOccupied: row.bedsOccupied!,
      occupancyPct: pct(row.bedsOccupied!, row.bedsTotal!),
      patients: row.patients!,
      abhaLinkedPct: pct(row.abhaLinked!, row.patients!),
      draftBills: row.draftBills!,
      lowStockDrugs: row.lowStockDrugs!,
      lowStockSupplies: row.lowStockSupplies!,
      wasteAwaitingDisposal: row.wasteAwaitingDisposal!,
      labPending: row.labPending!,
      criticalResults: row.criticalResults!,
    };
    res.json(summary);
  });

  return router;
}

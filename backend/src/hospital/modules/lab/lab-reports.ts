import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { parse } from "../../shared/validate.js";
import { getSettings } from "../masters/settings.js";
import { istDate, istEnd, istStart, round2 } from "../pharmacy/gst.js";

/**
 * Lab and radiology management figures for a period (by the date the test was ordered): how many tests, how fast they were reported
 * against the hours each test promises, what is still pending or overdue, and the money. The money is shown in two honest parts: what was
 * collected at the lab desk (exact, from the invoices), and the tests ordered on visits at the hospital's list price (those are billed
 * with the visit, after any panel rate or discount, so this is the value of the work, not the amount collected).
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OVERDUE_SQL = `(o.status NOT IN ('completed', 'cancelled') AND i."tatHours" IS NOT NULL AND now() > COALESCE(o."collectedAt", o."createdAt") + i."tatHours" * interval '1 hour')`;

export function labReportsRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/reports/summary", requireRole("lab", "admin"), async (req, res) => {
    const q = parse(z.object({ from: z.string().regex(DAY).optional(), to: z.string().regex(DAY).optional(), kind: z.enum(["lab", "radiology"]).optional() }), req.query);
    const to = q.to ?? istDate(new Date());
    const from = q.from ?? istDate(new Date(istStart(to).getTime() - 29 * 86_400_000));
    const range = [istStart(from).toISOString(), istEnd(to).toISOString(), q.kind ?? null];
    const unlisted = (await getSettings(db)).unlistedTestPrice;

    const totals = (await db.queryOne<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE o.status <> 'cancelled')::int AS ordered,
              count(*) FILTER (WHERE o.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE o.status NOT IN ('completed', 'cancelled'))::int AS pending,
              count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
              count(*) FILTER (WHERE o.critical AND o.status <> 'cancelled')::int AS critical,
              count(*) FILTER (WHERE o."amendedCount" > 0)::int AS amended
         FROM "ClinicalOrder" o LEFT JOIN "Investigation" i ON i.id = o."investigationId"
        WHERE o."facilityId" = :fid AND o."createdAt" >= $1 AND o."createdAt" < $2 AND ($3::text IS NULL OR o.type = $3)`,
      range,
    ))!;

    const tests = await db.query<{
      investigationId: string | null; name: string; kind: "lab" | "radiology"; section: string | null; tatHours: number | null;
      ordered: number; completed: number; avgTatHours: number | null; withTarget: number; withinTarget: number; visitValue: number; deskCollected: number;
    }>(
      `SELECT o."investigationId", COALESCE(i.name, o.name) AS name, o.type AS kind, i.section, i."tatHours",
              count(*) FILTER (WHERE o.status <> 'cancelled')::int AS ordered,
              count(*) FILTER (WHERE o.status = 'completed')::int AS completed,
              (avg(extract(epoch FROM (o."signedAt" - COALESCE(o."collectedAt", o."createdAt"))) / 3600) FILTER (WHERE o.status = 'completed'))::float8 AS avg_tat_hours,
              count(*) FILTER (WHERE o.status = 'completed' AND i."tatHours" IS NOT NULL)::int AS with_target,
              count(*) FILTER (WHERE o.status = 'completed' AND i."tatHours" IS NOT NULL
                               AND o."signedAt" <= COALESCE(o."collectedAt", o."createdAt") + i."tatHours" * interval '1 hour')::int AS within_target,
              COALESCE(sum(COALESCE(i.price, $4::numeric)) FILTER (WHERE o.status <> 'cancelled' AND o."labInvoiceId" IS NULL), 0)::float8 AS visit_value,
              COALESCE(sum(ii.amount) FILTER (WHERE li.status = 'paid'), 0)::float8 AS desk_collected
         FROM "ClinicalOrder" o
         LEFT JOIN "Investigation" i ON i.id = o."investigationId"
         LEFT JOIN "LabInvoiceItem" ii ON ii."orderId" = o.id
         LEFT JOIN "LabInvoice" li ON li.id = ii."invoiceId"
        WHERE o."facilityId" = :fid AND o."createdAt" >= $1 AND o."createdAt" < $2 AND ($3::text IS NULL OR o.type = $3)
        GROUP BY o."investigationId", COALESCE(i.name, o.name), o.type, i.section, i."tatHours"
        ORDER BY count(*) FILTER (WHERE o.status <> 'cancelled') DESC, 2
        LIMIT 500`,
      [...range, unlisted],
    );
    const rows = tests.filter((t) => t.ordered > 0 || t.completed > 0);

    const bySection = new Map<string, { section: string; kind: string; ordered: number; completed: number; visitValue: number; deskCollected: number }>();
    for (const t of rows) {
      const section = t.section ?? (t.kind === "radiology" ? "Radiology" : "No section");
      const row = bySection.get(section) ?? { section, kind: t.kind, ordered: 0, completed: 0, visitValue: 0, deskCollected: 0 };
      row.ordered += t.ordered;
      row.completed += t.completed;
      row.visitValue = round2(row.visitValue + t.visitValue);
      row.deskCollected = round2(row.deskCollected + t.deskCollected);
      bySection.set(section, row);
    }

    const desk = (await db.queryOne<{ count: number; total: number; cancelled: number }>(
      `SELECT count(*) FILTER (WHERE status = 'paid')::int AS count, COALESCE(sum(total) FILTER (WHERE status = 'paid'), 0)::float8 AS total,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM "LabInvoice" WHERE "facilityId" = :fid AND "createdAt" >= $1 AND "createdAt" < $2`,
      range.slice(0, 2),
    ))!;
    const criticalWaiting = (await db.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ClinicalOrder" WHERE "facilityId" = :fid AND critical AND "criticalAckAt" IS NULL AND status = 'completed'`,
    ))!.n;

    res.json({
      period: { from, to },
      totals: { ...totals, criticalWaiting },
      tests: rows.map((t) => ({
        ...t,
        avgTatHours: t.avgTatHours === null ? null : round2(t.avgTatHours),
        withinTargetPct: t.withTarget > 0 ? Math.round((t.withinTarget / t.withTarget) * 100) : null,
      })),
      sections: [...bySection.values()].sort((a, b) => b.ordered - a.ordered),
      desk,
    });
  });

  return router;
}

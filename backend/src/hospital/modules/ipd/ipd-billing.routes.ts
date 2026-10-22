import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { prepareFinalBill } from "../billing/billing.service.js";
import { addCharge, cancelAdvance, refundAdvance, requireIpd, runningBill, setBilling, takeAdvance, voidCharge } from "./running-bill.js";

const mode = z.enum(["cash", "upi", "card", "other"]);
const money = z.number().positive().max(10_000_000);

const chargeSchema = z.object({
  serviceId: z.uuid().optional(),
  description: z.string().trim().max(160).optional(),
  qty: z.number().int().min(1).max(1000).default(1),
  rate: z.number().min(0).max(10_000_000).optional(),
  gstPct: z.number().min(0).max(100).optional(),
  rateNote: z.string().trim().max(200).optional(),
  date: z.iso.date().optional(),
});
const billingSchema = z.object({ panelId: z.uuid().nullable(), beneficiaryId: z.string().trim().max(60).optional(), reprice: z.boolean().default(false) });
const advanceSchema = z.object({ amount: money, mode, reference: z.string().trim().max(60).optional(), note: z.string().trim().max(200).optional() });
const refundSchema = z.object({ amount: money, mode, reference: z.string().trim().max(60).optional(), reason: z.string().trim().min(3).max(200) });
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(200) });
const finalBillSchema = z.object({
  discount: z
    .union([z.object({ type: z.enum(["percent", "amount"]), value: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) }), z.null()])
    .optional(),
});

const COUNTER = ["biller", "admin"] as const;

/**
 * /api/v1/ipd-billing: the money side of an admission. The running bill (what the stay has cost so far), charges added from the ward or the
 * counter, advances and refunds with their receipts, the billing category (self-pay or a panel such as CGHS) and the final bill.
 *
 * Who may do what: the ward (nurses, doctors) can see the running bill and add services from the hospital's list; the front desk takes advances and
 * sets the billing category; changing a rate, one-off items, voiding, refunds, discounts and the final bill are for the billing counter and administrators.
 */
export function ipdBillingRouter({ db }: HospitalContext): Router {
  const router = Router();

  // Admissions with where their billing stands: who is in, how much advance is held, and the state of the final bill.
  router.get("/", async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["admitted", "discharged", "all"]).default("all") }), req.query);
    res.json(
      await db.query(
        `SELECT e.id AS "encounterId", e.status, e."admittedAt", e."dischargedAt", e.department, e."panelId", p.id AS "patientId", p.name AS patient_name, p.mrn,
                s.name AS doctor_name,
                (SELECT ward FROM "BedStay" WHERE "facilityId" = :fid AND "encounterId" = e.id ORDER BY "fromAt" DESC LIMIT 1) AS ward,
                (SELECT "bedNo" FROM "BedStay" WHERE "facilityId" = :fid AND "encounterId" = e.id ORDER BY "fromAt" DESC LIMIT 1) AS "bedNo",
                pn.code AS panel_code,
                COALESCE((SELECT sum(CASE kind WHEN 'advance' THEN amount WHEN 'refund' THEN -amount ELSE 0 END)
                            FROM "IpdPayment" WHERE "facilityId" = :fid AND "encounterId" = e.id AND NOT cancelled AND "billId" IS NULL), 0)::float8 AS advances_held,
                b.id AS "billId", b."billNo", b.status AS bill_status
           FROM "Encounter" e
           JOIN "Patient" p ON p.id = e."patientId"
           LEFT JOIN "Staff" s ON s.id = e."doctorId"
           LEFT JOIN "Panel" pn ON pn.id = e."panelId"
           LEFT JOIN "Bill" b ON b."encounterId" = e.id AND b.kind = 'final'
          WHERE e."facilityId" = :fid AND e.type = 'IPD' AND ($1::text = 'all' OR e.status = $1)
            AND (e.status = 'admitted' OR b.id IS NULL OR b.status <> 'paid')
          ORDER BY (e.status = 'admitted') DESC, e."admittedAt" DESC LIMIT 200`,
        [status],
      ),
    );
  });

  // The running bill. Opening it posts any bed day that has become due, so it is always current.
  router.get("/:encounterId", async (req, res) => {
    const id = uuidParam(req, "encounterId");
    res.json(
      await db.transaction(async (tx) => {
        await requireIpd(tx, id);
        return runningBill(tx, id, { post: true });
      }),
    );
  });

  router.post("/:encounterId/charges", requireRole("nurse", "doctor", "front_office", ...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const input = parse(chargeSchema, req.body);
    const counter = (COUNTER as readonly string[]).includes(staffOf(req).role);
    res.status(201).json(
      await db.transaction(async (tx) => {
        await addCharge(tx, id, input, actorOf(req), counter);
        return runningBill(tx, id, { post: true });
      }),
    );
  });

  router.post("/:encounterId/charges/:chargeId/void", requireRole(...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const { reason } = parse(reasonSchema, req.body);
    res.json(
      await db.transaction(async (tx) => {
        await voidCharge(tx, id, uuidParam(req, "chargeId"), reason, actorOf(req));
        return runningBill(tx, id, { post: true });
      }),
    );
  });

  router.put("/:encounterId/billing", requireRole("front_office", ...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const { panelId, beneficiaryId, reprice } = parse(billingSchema, req.body);
    res.json(
      await db.transaction(async (tx) => {
        await setBilling(tx, id, panelId, beneficiaryId, reprice, actorOf(req));
        return runningBill(tx, id, { post: true });
      }),
    );
  });

  router.post("/:encounterId/advances", requireRole("front_office", ...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const input = parse(advanceSchema, req.body);
    res.status(201).json(
      await db.transaction(async (tx) => ({
        receipt: await takeAdvance(tx, id, input, actorOf(req)),
        bill: await runningBill(tx, id, { post: false }),
      })),
    );
  });

  router.post("/:encounterId/refunds", requireRole(...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const input = parse(refundSchema, req.body);
    res.status(201).json(
      await db.transaction(async (tx) => ({
        receipt: await refundAdvance(tx, id, input, actorOf(req)),
        bill: await runningBill(tx, id, { post: false }),
      })),
    );
  });

  router.post("/:encounterId/payments/:paymentId/cancel", requireRole(...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const { reason } = parse(reasonSchema, req.body);
    res.json(
      await db.transaction(async (tx) => {
        await cancelAdvance(tx, id, uuidParam(req, "paymentId"), reason, actorOf(req));
        return runningBill(tx, id, { post: false });
      }),
    );
  });

  // The final bill: made after discharge, from the running bill. Send a discount (or null to clear one) to set it in the same step.
  router.post("/:encounterId/final-bill", requireRole(...COUNTER), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const { discount } = parse(finalBillSchema, req.body ?? {});
    res.status(201).json(await prepareFinalBill(db, id, discount, actorOf(req)));
  });

  return router;
}

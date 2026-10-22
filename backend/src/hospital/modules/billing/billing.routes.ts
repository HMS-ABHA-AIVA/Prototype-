import { Router } from "express";
import { z } from "zod";
import type { HospitalContext } from "../../context.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { applyDiscount, finalizeBill, getBill, listBillDtos, markBillPaid } from "./billing.service.js";

const discountSchema = z.union([
  z.object({ clear: z.literal(true) }),
  z.object({ type: z.enum(["percent", "amount"]), value: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) }),
]);

/**
 * Bills are created automatically when an encounter is closed, discharged or admitted onward
 * (see the encounters module); here staff review, give a discount on, finalize and mark them paid.
 * An admission's bill is prepared from its running bill (see the ipd module).
 */
export function billingRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { patientId, limit } = parse(z.object({ patientId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json(await listBillDtos(db, patientId ?? null, limit));
  });

  router.get("/:id", async (req, res) => {
    res.json(await getBill(db, uuidParam(req)));
  });

  // A discount (or removing one) on a draft bill; the lines are rebuilt so the tax stays right.
  router.post("/:id/discount", async (req, res) => {
    const body = parse(discountSchema, req.body);
    res.json(await applyDiscount(db, uuidParam(req), "clear" in body ? null : body, actorOf(req)));
  });

  router.post("/:id/finalize", async (req, res) => {
    res.json(await finalizeBill(db, uuidParam(req), actorOf(req)));
  });

  router.post("/:id/pay", async (req, res) => {
    const { paymentMode, reference, amountReceived } = parse(
      z.object({
        paymentMode: z.enum(["cash", "upi", "card", "other"]).default("cash"),
        reference: z.string().trim().max(60).optional(),
        amountReceived: z.number().min(0).optional(),
      }),
      req.body ?? {},
    );
    res.json(await markBillPaid(db, uuidParam(req), actorOf(req), { mode: paymentMode, reference, amountReceived }));
  });

  return router;
}

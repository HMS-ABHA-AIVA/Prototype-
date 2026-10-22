import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { findInvestigation } from "../masters/investigations.js";
import { itemRate, loadItemPricing } from "../masters/item-pricing.js";
import { findPanel } from "../panels/panels.js";
import { birthYearOf } from "../patients/patients.repository.js";
import { istEnd, istStart, round2 } from "../pharmacy/gst.js";

/**
 * Tests ordered at the lab desk for a registered patient who has no visit (a walk-in for a test, a referral from outside). They are paid for
 * at once on an invoice (LB-n) and become orders on the same worklist as everything else. Tests ordered on a visit are not invoiced here: they
 * go on that visit's bill. A panel's rate applies the same way as on a visit; a discount is a percentage off the rates.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const INVOICE_COLUMNS = `li.id, li."invoiceNo", li."patientId", p.name AS patient_name, p.mrn, ${birthYearOf("p")} AS "yearOfBirth", p.gender, NULLIF(p.phone, '') AS phone,
  li."panelId", li."panelName", li."beneficiaryId",
  li."discountPct"::float8 AS "discountPct", li.subtotal::float8 AS subtotal, li.discount::float8 AS discount, li."gstTotal"::float8 AS "gstTotal", li.total::float8 AS total,
  li."paymentMode", li."paymentReference", li."amountReceived"::float8 AS "amountReceived", li."referredBy", li.status, li."createdBy", li."createdAt",
  li."cancelledAt", li."cancelReason", li."cancelledBy"`;

interface InvoiceRow {
  id: string; invoiceNo: string; patientId: string; patientName: string; mrn: string; yearOfBirth: number | null; gender: string | null; phone: string | null;
  panelId: string | null; panelName: string | null; beneficiaryId: string | null; discountPct: number; subtotal: number; discount: number; gstTotal: number; total: number;
  paymentMode: "cash" | "upi" | "card" | "other"; paymentReference: string | null; amountReceived: number | null; referredBy: string | null;
  status: "paid" | "cancelled"; createdBy: string; createdAt: string; cancelledAt: string | null; cancelReason: string | null; cancelledBy: string | null;
}

export async function getLabInvoice(db: Queryable, id: string) {
  const invoice = await db.queryOne<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} FROM "LabInvoice" li JOIN "Patient" p ON p.id = li."patientId" WHERE li."facilityId" = :fid AND li.id = $1`, [id]);
  if (!invoice) return null;
  const items = await db.query<{ id: string; orderId: string; name: string; standardRate: number; rate: number; gstPct: number; amount: number; status: string; accessionNo: string | null }>(
    `SELECT i.id, i."orderId", i.name, i."standardRate"::float8 AS "standardRate", i.rate::float8 AS rate, i."gstPct"::float8 AS "gstPct", i.amount::float8 AS amount,
            o.status, o."accessionNo"
       FROM "LabInvoiceItem" i JOIN "ClinicalOrder" o ON o.id = i."orderId" WHERE i."facilityId" = :fid AND i."invoiceId" = $1 ORDER BY i.name`,
    [id],
  );
  const change = invoice.paymentMode === "cash" && invoice.amountReceived !== null ? round2(Math.max(0, invoice.amountReceived - invoice.total)) : null;
  return { ...invoice, items, change };
}

const createSchema = z.object({
  patientId: z.uuid(),
  tests: z.array(z.object({ investigationId: z.uuid() })).min(1).max(40),
  panelId: z.uuid().optional(),
  beneficiaryId: z.string().trim().max(60).optional(),
  discountPct: z.number().min(0).max(100).default(0),
  referredBy: z.string().trim().max(120).optional(),
  payment: z.object({ mode: z.enum(["cash", "upi", "card", "other"]), reference: z.string().trim().max(80).optional(), amountReceived: z.number().min(0).optional() }),
});
const quoteSchema = createSchema.pick({ tests: true, panelId: true, beneficiaryId: true, discountPct: true });

interface PricingInput {
  tests: { investigationId: string }[];
  panelId?: string | undefined;
  beneficiaryId?: string | undefined;
  discountPct: number;
}

/** What a set of tests comes to: each at the standard price or the panel's rate, less the discount, plus the GST. Nothing is saved. */
async function priceTests(tx: Queryable, input: PricingInput) {
  const ids = input.tests.map((t) => t.investigationId);
  if (new Set(ids).size !== ids.length) throw badRequest("A test is listed twice");
  let panel: { id: string; name: string; beneficiaryId: string | null } | null = null;
  if (input.panelId) {
    const p = await findPanel(tx, input.panelId);
    if (!p || !p.active) throw badRequest("That billing category is not available");
    if (p.requiresBeneficiaryId && !input.beneficiaryId?.trim()) throw badRequest(`Enter the ${p.code} beneficiary / card number`);
    panel = { id: p.id, name: p.name, beneficiaryId: input.beneficiaryId?.trim() || null };
  }
  const pricing = await loadItemPricing(tx, panel?.id ?? null);
  const lines = [];
  for (const id of ids) {
    const test = await findInvestigation(tx, id);
    if (!test || !test.active) throw badRequest("One of the tests is not on the hospital's list");
    const price = itemRate(pricing, "investigation", test);
    const net = round2(price.rate * (1 - input.discountPct / 100));
    const gst = round2((net * test.gstPct) / 100);
    lines.push({ test, standard: price.standard, rate: price.rate, net, gst, amount: round2(net + gst) });
  }
  return {
    panel,
    lines,
    subtotal: round2(lines.reduce((s, l) => s + l.rate, 0)),
    discount: round2(lines.reduce((s, l) => s + (l.rate - l.net), 0)),
    gstTotal: round2(lines.reduce((s, l) => s + l.gst, 0)),
    total: round2(lines.reduce((s, l) => s + l.amount, 0)),
  };
}

export function labInvoicesRouter({ db }: HospitalContext): Router {
  const router = Router();
  const desk = requireRole("lab", "front_office", "biller", "admin");

  // The exact amount before it is taken (panel rates, discount and GST included), so the counter can say it and count the cash.
  router.post("/invoices/quote", desk, async (req, res) => {
    const priced = await priceTests(db, parse(quoteSchema, req.body));
    res.json({
      panelName: priced.panel?.name ?? null,
      subtotal: priced.subtotal,
      discount: priced.discount,
      gstTotal: priced.gstTotal,
      total: priced.total,
      lines: priced.lines.map((l) => ({ investigationId: l.test.id, name: l.test.name, standardRate: l.standard, rate: l.rate, gstPct: l.test.gstPct, amount: l.amount })),
    });
  });

  router.post("/invoices", desk, async (req, res) => {
    const input = parse(createSchema, req.body);
    const actor = actorOf(req);
    const { mode, reference, amountReceived } = input.payment;
    if ((mode === "upi" || mode === "card") && (reference ?? "").trim().length < 3) {
      throw badRequest(mode === "upi" ? "Enter the UPI transaction id" : "Enter the card slip number or last digits");
    }

    res.status(201).json(
      await db.transaction(async (tx) => {
        const patient = await tx.queryOne<{ id: string; name: string }>('SELECT id, name FROM "Patient" WHERE "facilityId" = :fid AND id = $1', [input.patientId]);
        if (!patient) throw notFound("Patient");
        const { panel, lines, subtotal, discount, gstTotal, total } = await priceTests(tx, input);
        if (mode === "cash" && amountReceived !== undefined && amountReceived < total) throw badRequest("The cash received is less than the amount due");

        const invoice = (await tx.queryOne<{ id: string; invoiceNo: string }>(
          `INSERT INTO "LabInvoice" ("facilityId", "invoiceNo", "patientId", "panelId", "panelName", "beneficiaryId", "discountPct", subtotal, discount, "gstTotal", total,
                                    "paymentMode", "paymentReference", "amountReceived", "referredBy", "createdBy")
           VALUES (:fid, 'LB-' || next_facility_number(:fid, 'lab_invoice', 1), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, "invoiceNo"`,
          [
            patient.id, panel?.id ?? null, panel?.name ?? null, panel?.beneficiaryId ?? null, input.discountPct, subtotal, discount, gstTotal, total, mode, reference?.trim() || null,
            mode === "cash" ? amountReceived ?? null : null, input.referredBy?.trim() || null, actor,
          ],
        ))!;
        for (const l of lines) {
          const order = (await tx.queryOne<{ id: string }>(
            `INSERT INTO "ClinicalOrder" ("facilityId", "patientId", type, name, "investigationId", "labInvoiceId") VALUES (:fid, $1,$2,$3,$4,$5) RETURNING id`,
            [patient.id, l.test.kind, l.test.name, l.test.id, invoice.id],
          ))!;
          await tx.execute(
            `INSERT INTO "LabInvoiceItem" ("facilityId", "invoiceId", "orderId", name, "standardRate", rate, "gstPct", amount) VALUES (:fid, $1,$2,$3,$4,$5,$6,$7)`,
            [invoice.id, order.id, l.test.name, l.standard, l.rate, l.test.gstPct, l.amount],
          );
        }
        await recordAudit(tx, actor, "Lab Invoice Raised", `${invoice.invoiceNo}: ${lines.length} test(s) for ${patient.name}, Rs ${total} (${mode})`);
        return getLabInvoice(tx, invoice.id);
      }),
    );
  });

  router.get("/invoices", desk, async (req, res) => {
    const q = parse(
      z.object({
        from: z.string().regex(DAY).optional(),
        to: z.string().regex(DAY).optional(),
        status: z.enum(["paid", "cancelled"]).optional(),
        search: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const rows = await db.query<InvoiceRow & { itemCount: number }>(
      `SELECT ${INVOICE_COLUMNS}, (SELECT count(*)::int FROM "LabInvoiceItem" i WHERE i."facilityId" = :fid AND i."invoiceId" = li.id) AS item_count
         FROM "LabInvoice" li JOIN "Patient" p ON p.id = li."patientId"
        WHERE li."facilityId" = :fid AND ($1::timestamptz IS NULL OR li."createdAt" >= $1) AND ($2::timestamptz IS NULL OR li."createdAt" < $2)
          AND ($3::text IS NULL OR li.status = $3)
          AND ($4::text IS NULL OR li."invoiceNo" ILIKE '%' || $4 || '%' OR p.name ILIKE '%' || $4 || '%' OR p.mrn ILIKE '%' || $4 || '%')
        ORDER BY li."createdAt" DESC LIMIT $5`,
      [q.from ? istStart(q.from).toISOString() : null, q.to ? istEnd(q.to).toISOString() : null, q.status ?? null, q.search || null, q.limit],
    );
    const live = rows.filter((r) => r.status === "paid");
    res.json({ invoices: rows, totals: { count: live.length, total: round2(live.reduce((s, r) => s + r.total, 0)) } });
  });

  router.get("/invoices/:id", desk, async (req, res) => {
    const invoice = await getLabInvoice(db, uuidParam(req));
    if (!invoice) throw notFound("Invoice");
    res.json(invoice);
  });

  // Only while no work has started on any test: after that the tests are cancelled (or the report amended) one by one.
  router.post("/invoices/:id/cancel", requireRole("biller", "admin"), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    const id = uuidParam(req);
    res.json(
      await db.transaction(async (tx) => {
        const invoice = await tx.queryOne<{ id: string; invoiceNo: string; status: string }>(
          'SELECT id, "invoiceNo", status FROM "LabInvoice" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE',
          [id],
        );
        if (!invoice) throw notFound("Invoice");
        if (invoice.status === "cancelled") throw conflict("That invoice is already cancelled");
        const started = await tx.query<{ name: string }>(
          `SELECT name FROM "ClinicalOrder" WHERE "facilityId" = :fid AND "labInvoiceId" = $1 AND status <> 'ordered' AND status <> 'cancelled'`,
          [id],
        );
        if (started.length) throw conflict(`Work has started on ${started[0]!.name}: an invoice can be cancelled only before any sample is collected`);
        await tx.execute(
          `UPDATE "ClinicalOrder" SET status = 'cancelled', "cancelReason" = $2, "cancelledBy" = $3, "cancelledAt" = now()
            WHERE "facilityId" = :fid AND "labInvoiceId" = $1 AND status = 'ordered'`,
          [id, `Invoice cancelled: ${reason}`, actorOf(req)],
        );
        await tx.execute(`UPDATE "LabInvoice" SET status = 'cancelled', "cancelledAt" = now(), "cancelReason" = $2, "cancelledBy" = $3 WHERE "facilityId" = :fid AND id = $1`, [
          id, reason, actorOf(req),
        ]);
        await recordAudit(tx, actorOf(req), "Lab Invoice Cancelled", `${invoice.invoiceNo}: ${reason}`);
        return getLabInvoice(tx, id);
      }),
    );
  });

  return router;
}

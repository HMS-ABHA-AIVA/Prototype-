import express, { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { MAX_DOCUMENT_BYTES, sniff } from "../ipd/ipd.routes.js";
import { getSettings } from "../masters/settings.js";
import { birthYearOf } from "../patients/patients.repository.js";
import { istEnd, istStart } from "../pharmacy/gst.js";
import { labInvoicesRouter } from "./lab-invoices.js";
import { labReportsRouter } from "./lab-reports.js";
import { isResultOf, loadParameters, loadResults, saveResults, type ResultRow } from "./results.js";

/**
 * Laboratory and radiology. An order placed on a visit (or at the lab desk, see lab-invoices) becomes a piece of work:
 *
 *   lab:        ordered -> sample collected (sample number) -> results entered -> signed (report released)
 *   radiology:  ordered -> study started (accession number) -> report written (findings, impression) -> signed
 *
 * Every step records who did it and when. A signed report is never overwritten: a correction is an amendment that keeps what was there.
 * Whether the person who entered the results may sign them is a hospital setting (second-person verification).
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Overdue: still not signed, and past the hours the test promises (counted from the sample, or from the order if no sample yet). */
const OVERDUE_SQL = `(o.status NOT IN ('completed', 'cancelled') AND i."tatHours" IS NOT NULL AND now() > COALESCE(o."collectedAt", o."createdAt") + i."tatHours" * interval '1 hour')`;

/** An order with everything the screens need; callers add `AND ...` conditions. */
const ORDER_SELECT = `SELECT o.id, o.type AS kind, o.name, o.status, o."accessionNo", o."createdAt", o."collectedAt", o."collectedBy", o."sampleNote",
    o."resultedAt", o."resultedBy", o.remarks, o.findings, o.impression, o."signedAt", o."signedBy", o."amendedCount", o.critical, o."criticalAckBy", o."criticalAckAt",
    o."cancelReason", o."cancelledBy", o."cancelledAt", o."investigationId", i.code AS test_code, i.section, i.sample, i."tatHours",
    ${OVERDUE_SQL} AS overdue,
    o."encounterId", e.type AS encounter_type, e.department, d.name AS ordered_by, o."labInvoiceId", li."invoiceNo", li."referredBy",
    o."patientId", p.name AS patient_name, p.mrn, ${birthYearOf("p")} AS "yearOfBirth", p.gender, NULLIF(p.phone, '') AS phone
  FROM "ClinicalOrder" o
  JOIN "Patient" p ON p.id = o."patientId"
  LEFT JOIN "Investigation" i ON i.id = o."investigationId"
  LEFT JOIN "Encounter" e ON e.id = o."encounterId"
  LEFT JOIN "Staff" d ON d.id = e."doctorId"
  LEFT JOIN "LabInvoice" li ON li.id = o."labInvoiceId"
 WHERE o."facilityId" = :fid`;

type Status = "ordered" | "sample_collected" | "in_progress" | "resulted" | "completed" | "cancelled";
interface OrderDetailRow {
  id: string; kind: "lab" | "radiology"; name: string; status: Status; accessionNo: string | null; createdAt: string; collectedAt: string | null; collectedBy: string | null;
  sampleNote: string | null; resultedAt: string | null; resultedBy: string | null; remarks: string | null; findings: string | null; impression: string | null;
  signedAt: string | null; signedBy: string | null; amendedCount: number; critical: boolean; criticalAckBy: string | null; criticalAckAt: string | null;
  cancelReason: string | null; cancelledBy: string | null; cancelledAt: string | null; investigationId: string | null; testCode: string | null; section: string | null;
  sample: string | null; tatHours: number | null; overdue: boolean; encounterId: string | null; encounterType: string | null; department: string | null;
  orderedBy: string | null; labInvoiceId: string | null; invoiceNo: string | null; referredBy: string | null;
  patientId: string; patientName: string; mrn: string; yearOfBirth: number | null; gender: string | null; phone: string | null;
}

const findOrder = (db: Queryable, id: string) => db.queryOne<OrderDetailRow>(`${ORDER_SELECT} AND o.id = $1`, [id]);

/** The order row, locked for the change being made. */
async function lockOrder(tx: Queryable, id: string) {
  const row = await tx.queryOne<{ id: string }>('SELECT id FROM "ClinicalOrder" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE', [id]);
  if (!row) throw notFound("Test order");
  return (await findOrder(tx, id))!;
}

const WORKERS = ["lab", "doctor", "admin"] as const; // enter results, write and sign reports
const READERS = ["lab", "doctor", "nurse", "admin"] as const;

interface AttachmentRow {
  id: string;
  orderId: string;
  title: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  removed: boolean;
}
const ATTACHMENT_COLUMNS = 'id, "orderId", title, "fileName", "contentType", "sizeBytes", "uploadedBy", "uploadedAt", removed';

/** What the entry form shows: each thing the test measures with its range and the value saved so far, then any extra rows that were added. */
function entryForm(parameters: Awaited<ReturnType<typeof loadParameters>>, saved: ResultRow[]) {
  const used = new Set<string>();
  const rows = parameters.map((p) => {
    const r = saved.find((x) => isResultOf(x, p));
    if (r) used.add(r.id);
    return {
      parameterId: p.id as string | null, name: p.name, unit: p.unit, refLow: p.refLow, refHigh: p.refHigh, refText: p.refText, criticalLow: p.criticalLow,
      criticalHigh: p.criticalHigh, value: r?.valueText ?? "", flag: r?.flag ?? null,
    };
  });
  for (const r of saved) {
    if (used.has(r.id)) continue;
    rows.push({
      parameterId: null, name: r.name, unit: r.unit, refLow: r.refLow, refHigh: r.refHigh, refText: r.refText, criticalLow: r.criticalLow, criticalHigh: r.criticalHigh,
      value: r.valueText, flag: r.flag,
    });
  }
  return rows;
}

async function amendments(db: Queryable, orderId: string) {
  return db.query<{ id: string; reason: string; amendedBy: string; amendedAt: string }>(
    'SELECT id, reason, "amendedBy", "amendedAt" FROM "ReportAmendment" WHERE "facilityId" = :fid AND "orderId" = $1 ORDER BY "amendedAt"',
    [orderId],
  );
}

const attachmentsOf = (db: Queryable, orderId: string) =>
  db.query<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM "OrderAttachment" WHERE "facilityId" = :fid AND "orderId" = $1 AND NOT removed ORDER BY "uploadedAt"`, [orderId]);

/** An order with everything on it: for the lab, the working form; for a doctor or nurse, results only once the report is signed. */
async function orderDetail(db: Queryable, id: string, role: string) {
  const order = await findOrder(db, id);
  if (!order) throw notFound("Test order");
  const released = order.status === "completed";
  const sees = released || role === "lab" || role === "admin";
  const saved = sees ? await loadResults(db, id) : [];
  const parameters = order.kind === "lab" ? await loadParameters(db, order.investigationId) : [];
  const hidden = { remarks: null, findings: null, impression: null };
  return {
    ...order,
    ...(sees ? {} : hidden),
    form: order.kind === "lab" && sees ? entryForm(parameters, saved) : [],
    results: saved,
    attachments: sees ? await attachmentsOf(db, id) : [],
    amendments: await amendments(db, id),
  };
}

export function labRouter(ctx: HospitalContext): Router {
  const { db, files } = ctx;
  const router = Router();

  // ---- the worklist ----------------------------------------------------------------------------------------------------
  router.get("/orders", requireRole(...READERS), async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(["open", "all", "ordered", "sample_collected", "in_progress", "resulted", "completed", "cancelled"]).default("open"),
        kind: z.enum(["lab", "radiology"]).optional(),
        source: z.enum(["visit", "desk"]).optional(),
        overdue: z.enum(["true", "false"]).default("false"),
        from: z.string().regex(DAY).optional(),
        to: z.string().regex(DAY).optional(),
        search: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const rows = await db.query<OrderDetailRow>(
      `${ORDER_SELECT}
          AND ($1::text = 'all' OR ($1 = 'open' AND o.status NOT IN ('completed', 'cancelled')) OR o.status = $1)
          AND ($2::text IS NULL OR o.type = $2)
          AND ($3::text IS NULL OR ($3 = 'visit' AND o."encounterId" IS NOT NULL) OR ($3 = 'desk' AND o."encounterId" IS NULL))
          AND (NOT $4::boolean OR ${OVERDUE_SQL})
          AND ($5::timestamptz IS NULL OR o."createdAt" >= $5) AND ($6::timestamptz IS NULL OR o."createdAt" < $6)
          AND ($7::text IS NULL OR p.name ILIKE '%' || $7 || '%' OR p.mrn ILIKE '%' || $7 || '%' OR o.name ILIKE '%' || $7 || '%' OR o."accessionNo" ILIKE '%' || $7 || '%')
        ORDER BY o."createdAt" ${q.status === "open" ? "ASC" : "DESC"} LIMIT $8`,
      [q.status, q.kind ?? null, q.source ?? null, q.overdue === "true", q.from ? istStart(q.from).toISOString() : null, q.to ? istEnd(q.to).toISOString() : null, q.search || null, q.limit],
    );
    const counts = (await db.queryOne<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE o.status = 'ordered')::int AS ordered,
              count(*) FILTER (WHERE o.status IN ('sample_collected', 'in_progress'))::int AS in_progress,
              count(*) FILTER (WHERE o.status = 'resulted')::int AS awaiting_signature,
              count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue,
              count(*) FILTER (WHERE o.critical AND o."criticalAckAt" IS NULL AND o.status = 'completed')::int AS critical_unacknowledged
         FROM "ClinicalOrder" o LEFT JOIN "Investigation" i ON i.id = o."investigationId"
        WHERE o."facilityId" = :fid`,
    ))!;
    res.json({
      orders: rows.map(({ remarks, findings, impression, ...row }) => {
        void remarks;
        void findings;
        void impression;
        return row;
      }),
      counts,
    });
  });

  // Critical results nobody has acknowledged yet: what a doctor must see.
  router.get("/critical", requireRole(...READERS), async (_req, res) => {
    res.json(
      await db.query(
        `SELECT o.id, o.name, o."accessionNo", o."signedAt", o."patientId", p.name AS patient_name, p.mrn, o."encounterId", d.name AS ordered_by
           FROM "ClinicalOrder" o JOIN "Patient" p ON p.id = o."patientId" LEFT JOIN "Encounter" e ON e.id = o."encounterId" LEFT JOIN "Staff" d ON d.id = e."doctorId"
          WHERE o."facilityId" = :fid AND o.critical AND o."criticalAckAt" IS NULL AND o.status = 'completed' ORDER BY o."signedAt" LIMIT 100`,
      ),
    );
  });

  router.get("/orders/:id", requireRole(...READERS), async (req, res) => {
    res.json(await orderDetail(db, uuidParam(req), staffOf(req).role));
  });

  // ---- the work ------------------------------------------------------------------------------------------------------
  // Sample collected (lab) or study started (radiology): this issues the sample or accession number.
  router.post("/orders/:id/collect", requireRole("lab", "nurse", "doctor", "admin"), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(200).optional() }), req.body ?? {});
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.status !== "ordered") {
        throw conflict(o.status === "cancelled" ? "This test was cancelled" : o.kind === "lab" ? "The sample for this test has already been collected" : "This study has already been started");
      }
      // Sample numbers (LS-n) and accession numbers (RD-n) run per hospital.
      const number = (await tx.queryOne<{ n: string }>(
        o.kind === "lab"
          ? `SELECT 'LS-' || next_facility_number(:fid, 'lab_sample', 1) AS n`
          : `SELECT 'RD-' || next_facility_number(:fid, 'radiology_accession', 1) AS n`,
      ))!.n;
      await tx.execute(`UPDATE "ClinicalOrder" SET status = $2, "accessionNo" = $3, "collectedAt" = now(), "collectedBy" = $4, "sampleNote" = $5 WHERE "facilityId" = :fid AND id = $1`, [
        id, o.kind === "lab" ? "sample_collected" : "in_progress", number, actorOf(req), note || null,
      ]);
      await recordAudit(tx, actorOf(req), o.kind === "lab" ? "Sample Collected" : "Radiology Study Started", `${number}: ${o.name} for ${o.patientName}`);
    });
    res.json(await orderDetail(db, id, staffOf(req).role));
  });

  // A bad sample (haemolysed, wrong tube): it goes back to "ordered" so it can be collected again, and the reason is kept.
  router.post("/orders/:id/reject-sample", requireRole("lab", "admin"), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.kind !== "lab" || o.status !== "sample_collected") throw conflict("Only a collected sample that has no results yet can be rejected");
      await tx.execute(
        `UPDATE "ClinicalOrder" SET status = 'ordered', "sampleNote" = $2, "collectedAt" = NULL, "collectedBy" = NULL, "accessionNo" = NULL WHERE "facilityId" = :fid AND id = $1`,
        [id, `Sample rejected: ${reason}`],
      );
      await recordAudit(tx, actorOf(req), "Sample Rejected", `${o.accessionNo}: ${o.name} for ${o.patientName} - ${reason}`);
    });
    res.json(await orderDetail(db, id, staffOf(req).role));
  });

  // Lab: the values. Can be saved again until the report is signed.
  router.put("/orders/:id/results", requireRole(...WORKERS), async (req, res) => {
    const body = parse(
      z.object({
        results: z
          .array(z.object({ parameterId: z.uuid().optional(), name: z.string().trim().max(80).optional(), value: z.string().trim().max(120), abnormal: z.boolean().optional() }))
          .max(80),
        remarks: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    const id = uuidParam(req);
    const staff = staffOf(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.kind !== "lab") throw badRequest("A radiology study has a written report, not results");
      if (o.status !== "sample_collected" && o.status !== "resulted") {
        throw conflict(o.status === "ordered" ? "Collect the sample first" : o.status === "completed" ? "The report is already signed: amend it to change a value" : "This test was cancelled");
      }
      const saved = await saveResults(tx, id, o.investigationId, body.results);
      await tx.execute(
        `UPDATE "ClinicalOrder" SET status = 'resulted', "resultedAt" = now(), "resultedBy" = $2, "resultedByStaffId" = $3, remarks = $4, critical = $5 WHERE "facilityId" = :fid AND id = $1`,
        [id, actorOf(req), staff.id, body.remarks || null, saved.critical],
      );
      await recordAudit(tx, actorOf(req), "Lab Results Entered", `${o.accessionNo}: ${o.name} for ${o.patientName} (${saved.count} value(s)${saved.critical ? ", CRITICAL" : ""})`);
    });
    res.json(await orderDetail(db, id, staff.role));
  });

  // Radiology: the written report.
  router.put("/orders/:id/report", requireRole(...WORKERS), async (req, res) => {
    const body = parse(z.object({ findings: z.string().trim().min(3).max(6000), impression: z.string().trim().min(3).max(2000) }), req.body);
    const id = uuidParam(req);
    const staff = staffOf(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.kind !== "radiology") throw badRequest("A lab test has results, not a written report");
      if (o.status !== "in_progress" && o.status !== "resulted") {
        throw conflict(o.status === "ordered" ? "Start the study first" : o.status === "completed" ? "The report is already signed: amend it to change it" : "This study was cancelled");
      }
      await tx.execute(
        `UPDATE "ClinicalOrder" SET status = 'resulted', "resultedAt" = now(), "resultedBy" = $2, "resultedByStaffId" = $3, findings = $4, impression = $5 WHERE "facilityId" = :fid AND id = $1`,
        [id, actorOf(req), staff.id, body.findings, body.impression],
      );
      await recordAudit(tx, actorOf(req), "Radiology Report Written", `${o.accessionNo}: ${o.name} for ${o.patientName}`);
    });
    res.json(await orderDetail(db, id, staff.role));
  });

  // Sign: the report is released. When the hospital asks for verification, it cannot be the person who entered the results.
  router.post("/orders/:id/sign", requireRole(...WORKERS), async (req, res) => {
    const id = uuidParam(req);
    const staff = staffOf(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.status !== "resulted") throw conflict(o.status === "completed" ? "This report is already signed" : o.status === "cancelled" ? "This test was cancelled" : "There are no results to sign yet");
      const enteredBy = (await tx.queryOne<{ id: string | null }>('SELECT "resultedByStaffId" AS id FROM "ClinicalOrder" WHERE "facilityId" = :fid AND id = $1', [id]))!.id;
      if ((await getSettings(tx)).requireReportVerification && enteredBy === staff.id) {
        throw forbidden("This hospital needs a second person to verify a report: it cannot be signed by the person who entered the results");
      }
      if (o.kind === "lab") {
        const params = await loadParameters(tx, o.investigationId);
        const saved = await loadResults(tx, id);
        const missing = params.filter((p) => !saved.some((r) => isResultOf(r, p))).map((p) => p.name);
        if (missing.length) throw badRequest(`Enter a result for ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} (or write "-" if it was not done)`);
        if (saved.length === 0) throw badRequest("There are no results to sign");
      } else if (!o.findings || !o.impression) {
        throw badRequest("Write the findings and the impression before signing");
      }
      await tx.execute(`UPDATE "ClinicalOrder" SET status = 'completed', "signedAt" = now(), "signedBy" = $2, "signedByStaffId" = $3 WHERE "facilityId" = :fid AND id = $1`, [
        id, actorOf(req), staff.id,
      ]);
      await recordAudit(tx, actorOf(req), "Report Signed", `${o.accessionNo}: ${o.name} for ${o.patientName}${o.critical ? " (critical value)" : ""}`);
    });
    res.json(await orderDetail(db, id, staff.role));
  });

  // A correction to a released report. What was there is kept, with who changed it and why; the report is signed again afterwards.
  router.post("/orders/:id/amend", requireRole(...WORKERS), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.status !== "completed") throw conflict("Only a signed report can be amended");
      const previous = {
        results: (await loadResults(tx, id)).map((r) => ({ name: r.name, unit: r.unit, value: r.valueText, flag: r.flag, refLow: r.refLow, refHigh: r.refHigh })),
        remarks: o.remarks, findings: o.findings, impression: o.impression, resultedBy: o.resultedBy, signedBy: o.signedBy, signedAt: o.signedAt,
      };
      await tx.execute('INSERT INTO "ReportAmendment" ("facilityId", "orderId", reason, "amendedBy", previous) VALUES (:fid, $1,$2,$3,$4::jsonb)', [
        id, reason, actorOf(req), JSON.stringify(previous),
      ]);
      await tx.execute(
        `UPDATE "ClinicalOrder" SET status = 'resulted', "signedAt" = NULL, "signedBy" = NULL, "signedByStaffId" = NULL, "amendedCount" = "amendedCount" + 1
          WHERE "facilityId" = :fid AND id = $1`,
        [id],
      );
      await recordAudit(tx, actorOf(req), "Report Amended", `${o.accessionNo}: ${o.name} for ${o.patientName} - ${reason}`);
    });
    res.json(await orderDetail(db, id, staffOf(req).role));
  });

  // A doctor has seen the critical value.
  router.post("/orders/:id/acknowledge-critical", requireRole("doctor", "admin"), async (req, res) => {
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (!o.critical || o.status !== "completed") throw conflict("This report has no critical value to acknowledge");
      if (o.criticalAckAt) throw conflict("This critical value has already been acknowledged");
      await tx.execute('UPDATE "ClinicalOrder" SET "criticalAckBy" = $2, "criticalAckAt" = now() WHERE "facilityId" = :fid AND id = $1', [id, actorOf(req)]);
      await recordAudit(tx, actorOf(req), "Critical Result Acknowledged", `${o.accessionNo}: ${o.name} for ${o.patientName}`);
    });
    res.json(await orderDetail(db, id, staffOf(req).role));
  });

  // A test that is not going to be done. Not charged. Once the visit's bill has been raised the bill has to be corrected by the billing counter instead.
  router.post("/orders/:id/cancel", requireRole("lab", "doctor", "admin"), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const o = await lockOrder(tx, id);
      if (o.status === "cancelled") throw conflict("This test is already cancelled");
      if (o.status === "resulted" || o.status === "completed") throw conflict("Results have been entered for this test, so it cannot be cancelled");
      if (o.labInvoiceId) throw conflict(`This test is on invoice ${o.invoiceNo}: cancel the invoice instead`);
      if (o.encounterId && (await tx.queryOne(`SELECT 1 FROM "Bill" WHERE "facilityId" = :fid AND "encounterId" = $1 AND kind = 'final'`, [o.encounterId]))) {
        throw conflict("The bill for this visit has already been raised: ask the billing counter to correct the bill");
      }
      await tx.execute(`UPDATE "ClinicalOrder" SET status = 'cancelled', "cancelReason" = $2, "cancelledBy" = $3, "cancelledAt" = now() WHERE "facilityId" = :fid AND id = $1`, [
        id, reason, actorOf(req),
      ]);
      await recordAudit(tx, actorOf(req), "Test Cancelled", `${o.name} for ${o.patientName}: ${reason}`);
    });
    res.json(await orderDetail(db, id, staffOf(req).role));
  });

  // ---- the signed report ---------------------------------------------------------------------------------------------
  router.get("/orders/:id/report", requireRole(...READERS, "front_office"), async (req, res) => {
    const id = uuidParam(req);
    const detail = await orderDetail(db, id, "lab");
    if (detail.status !== "completed") throw conflict("This report has not been signed yet");
    const signer =
      (await db.queryOne<{ id: string; name: string; hprId: string | null; department: string }>(
        'SELECT s.id, s.name, s."hprId", s.department FROM "Staff" s JOIN "ClinicalOrder" o ON o."signedByStaffId" = s.id WHERE o."facilityId" = :fid AND o.id = $1',
        [id],
      )) ?? null;
    res.json({ ...detail, signer });
  });

  // A patient's signed reports, newest first (for the chart).
  router.get("/patients/:patientId/reports", requireRole(...READERS, "front_office"), async (req, res) => {
    res.json(
      await db.query(
        `SELECT o.id, o.type AS kind, o.name, o."accessionNo", o."signedAt", o.critical, o."amendedCount", o."encounterId"
           FROM "ClinicalOrder" o WHERE o."facilityId" = :fid AND o."patientId" = $1 AND o.status = 'completed' ORDER BY o."signedAt" DESC LIMIT 200`,
        [uuidParam(req, "patientId")],
      ),
    );
  });

  // ---- images and files on a radiology study --------------------------------------------------------------------------
  const attachRoles = requireRole(...WORKERS);

  router.post("/orders/:id/attachments", attachRoles, express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    if (files.kind === "none") {
      throw new AppError(503, "STORAGE_NOT_CONFIGURED", "File storage is not set up on this server yet, so images cannot be saved. Ask your administrator.");
    }
    const id = uuidParam(req);
    const { title, fileName } = parse(z.object({ title: z.string().trim().min(2).max(120), fileName: z.string().trim().max(160).default("image") }), req.query);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (data.length === 0) throw badRequest("No file was received");
    const type = sniff(data);
    if (!type) throw badRequest("Only PDF, PNG, JPEG or WEBP files can be attached");
    res.status(201).json(
      await db.transaction(async (tx) => {
        const o = await lockOrder(tx, id);
        if (o.kind !== "radiology") throw badRequest("Images are attached to radiology studies");
        if (o.status === "cancelled" || o.status === "completed") throw conflict(o.status === "completed" ? "The report is signed: amend it to add an image" : "This study was cancelled");
        const attachmentId = (await tx.queryOne<{ id: string }>("SELECT gen_random_uuid()::text AS id"))!.id;
        // Files are kept apart per hospital in storage too.
        const key = `${tx.fid}/lab/${id}/${attachmentId}`;
        const safeName = `${fileName.replace(/[^\w.\- ()]/g, "_").replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${type.ext}`;
        await files.put(key, data);
        const row = await tx.queryOne<AttachmentRow>(
          `INSERT INTO "OrderAttachment" (id, "facilityId", "orderId", title, "fileName", "contentType", "sizeBytes", "storageKey", "uploadedBy")
           VALUES ($1, :fid, $2,$3,$4,$5,$6,$7,$8) RETURNING ${ATTACHMENT_COLUMNS}`,
          [attachmentId, id, title, safeName, type.type, data.length, key, actorOf(req)],
        );
        await recordAudit(tx, actorOf(req), "Study Image Attached", `${o.accessionNo}: ${title} (${Math.round(data.length / 1024)} KB)`);
        return row;
      }),
    );
  });

  router.get("/attachments/:id/file", requireRole(...READERS), async (req, res) => {
    const role = staffOf(req).role;
    const a = await db.queryOne<{ id: string; title: string; fileName: string; contentType: string; storageKey: string; removed: boolean; status: Status }>(
      `SELECT a.id, a.title, a."fileName", a."contentType", a."storageKey", a.removed, o.status
         FROM "OrderAttachment" a JOIN "ClinicalOrder" o ON o.id = a."orderId" WHERE a."facilityId" = :fid AND a.id = $1`,
      [uuidParam(req)],
    );
    if (!a || (a.removed && role !== "admin")) throw notFound("Attachment");
    // Until the report is signed, only the lab sees the images.
    if (a.status !== "completed" && role !== "lab" && role !== "admin") throw forbidden();
    const data = await files.get(a.storageKey);
    if (!data) throw new AppError(404, "NOT_FOUND", "The file could not be found in storage");
    await recordAudit(db, actorOf(req), "Study Image Viewed", a.title);
    res.setHeader("Content-Type", a.contentType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(data);
  });

  router.post("/attachments/:id/remove", attachRoles, async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const a = await tx.queryOne<{ title: string; removed: boolean; status: Status }>(
        'SELECT a.title, a.removed, o.status FROM "OrderAttachment" a JOIN "ClinicalOrder" o ON o.id = a."orderId" WHERE a."facilityId" = :fid AND a.id = $1 FOR UPDATE OF a',
        [id],
      );
      if (!a) throw notFound("Attachment");
      if (a.removed) throw conflict("That file is already removed");
      if (a.status === "completed") throw conflict("The report is signed: amend it to remove an image");
      await tx.execute('UPDATE "OrderAttachment" SET removed = true, "removedBy" = $2, "removedAt" = now(), "removeReason" = $3 WHERE "facilityId" = :fid AND id = $1', [
        id, actorOf(req), reason,
      ]);
      await recordAudit(tx, actorOf(req), "Study Image Removed", `${a.title}: ${reason}`);
    });
    res.json({ removed: true });
  });

  router.use(labInvoicesRouter(ctx));
  router.use(labReportsRouter(ctx));
  return router;
}

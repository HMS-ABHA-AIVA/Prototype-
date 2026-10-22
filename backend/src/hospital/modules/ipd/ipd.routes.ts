import express, { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { recordAudit } from "../../shared/audit.js";
import { AppError, badRequest, conflict, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { findEncounter } from "../encounters/encounters.repository.js";
import { findPatient } from "../patients/patients.repository.js";

// ---- Births ----------------------------------------------------------------------------------------------------------------

const birthSchema = z.object({
  babyName: z.string().trim().max(120).optional(),
  gender: z.enum(["M", "F", "O"]),
  bornAt: z.iso.datetime({ offset: true }).optional(),
  weightGrams: z.number().int().min(300).max(8000).optional(),
  deliveryType: z.enum(["normal", "caesarean", "assisted", "other"]),
  fatherName: z.string().trim().max(120).optional(),
  attendedBy: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

const BIRTH_COLUMNS = `b.id, b."birthNo", b."motherEncounterId", b."motherPatientId", p.name AS mother_name, p.mrn AS mother_mrn, b."babyName", b.gender,
  b."bornAt", b."weightGrams", b."deliveryType", b."fatherName", b."attendedBy", b.notes, b."recordedBy", b."createdAt"`;

// ---- Documents -------------------------------------------------------------------------------------------------------------

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const KINDS = ["consent", "report", "scan", "prescription", "other"] as const;

/** The kind of file, from what its first bytes say (not from the name or the type the sender claims). */
export function sniff(data: Buffer): { type: string; ext: string } | null {
  if (data.length >= 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return { type: "application/pdf", ext: "pdf" };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

const DOC_COLUMNS = 'id, "encounterId", "patientId", kind, title, "fileName", "contentType", "sizeBytes", "uploadedBy", "uploadedAt", removed, "removedBy", "removedAt", "removeReason"';

/**
 * /api/v1/ipd: things recorded against an admission that are not billing: the birth register (with the certificate's data) and attached
 * documents (consent forms, outside reports, scans). Documents are checked by their content, size-limited, kept apart per hospital, and
 * removed only by being marked removed with a reason (the file and the record stay for the audit trail).
 */
export function ipdRouter({ db, files }: HospitalContext): Router {
  const router = Router();

  // ---- births ----
  router.get("/:encounterId/births", requireRole("nurse", "doctor", "front_office", "admin"), async (req, res) => {
    res.json(
      await db.query(
        `SELECT ${BIRTH_COLUMNS} FROM "Birth" b JOIN "Patient" p ON p.id = b."motherPatientId"
          WHERE b."facilityId" = :fid AND b."motherEncounterId" = $1 ORDER BY b."bornAt"`,
        [uuidParam(req, "encounterId")],
      ),
    );
  });

  router.post("/:encounterId/births", requireRole("nurse", "doctor", "admin"), async (req, res) => {
    const id = uuidParam(req, "encounterId");
    const b = parse(birthSchema, req.body);
    const bornAt = b.bornAt ? new Date(b.bornAt) : new Date();
    res.status(201).json(
      await db.transaction(async (tx) => {
        const stay = await findEncounter(tx, id);
        if (!stay || stay.type !== "IPD") throw notFound("Admission");
        const mother = (await findPatient(tx, stay.patientId))!;
        if (mother.gender === "M") throw badRequest("The mother of a newborn cannot be recorded as male");
        if (stay.admittedAt && bornAt < new Date(stay.admittedAt)) throw badRequest("The birth cannot be before the mother's admission");
        if (bornAt.getTime() > Date.now() + 3600_000) throw badRequest("The time of birth is in the future");
        const row = await tx.queryOne<{ id: string }>(
          `INSERT INTO "Birth" ("facilityId", "motherEncounterId", "motherPatientId", "babyName", gender, "bornAt", "weightGrams", "deliveryType", "fatherName", "attendedBy", notes, "recordedBy")
           VALUES (:fid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            id, stay.patientId, b.babyName || null, b.gender, bornAt.toISOString(), b.weightGrams ?? null, b.deliveryType, b.fatherName || null, b.attendedBy || null,
            b.notes || null, actorOf(req),
          ],
        );
        const birth = await tx.queryOne<{ birthNo: string }>(
          `SELECT ${BIRTH_COLUMNS} FROM "Birth" b JOIN "Patient" p ON p.id = b."motherPatientId" WHERE b."facilityId" = :fid AND b.id = $1`,
          [row!.id],
        );
        await recordAudit(tx, actorOf(req), "Birth Recorded", `${birth!.birthNo}: ${b.gender === "M" ? "boy" : b.gender === "F" ? "girl" : "baby"} to ${mother.name}`);
        return birth;
      }),
    );
  });

  // ---- documents ----
  const docRoles = requireRole("nurse", "doctor", "front_office", "biller", "admin");

  router.get("/:encounterId/documents", docRoles, async (req, res) => {
    const includeRemoved = staffOf(req).role === "admin" && req.query.removed === "true";
    res.json(
      await db.query(
        `SELECT ${DOC_COLUMNS} FROM "EncounterDocument" WHERE "facilityId" = :fid AND "encounterId" = $1 AND ($2::boolean OR NOT removed) ORDER BY "uploadedAt" DESC`,
        [uuidParam(req, "encounterId"), includeRemoved],
      ),
    );
  });

  // The file itself is the request body (any of PDF, PNG, JPEG, WEBP up to 10 MB); the details travel in the query string.
  router.post("/:encounterId/documents", docRoles, express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    if (files.kind === "none") {
      throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Document storage is not set up on this server yet, so documents cannot be saved. Ask your administrator.");
    }
    const id = uuidParam(req, "encounterId");
    const { kind, title, fileName } = parse(
      z.object({ kind: z.enum(KINDS).default("other"), title: z.string().trim().min(2).max(120), fileName: z.string().trim().max(160).default("document") }),
      req.query,
    );
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (data.length === 0) throw badRequest("No file was received");
    const type = sniff(data);
    if (!type) throw badRequest("Only PDF, PNG, JPEG or WEBP files can be attached");

    res.status(201).json(
      await db.transaction(async (tx) => {
        const stay = await findEncounter(tx, id);
        if (!stay) throw notFound("Visit");
        const docId = (await tx.queryOne<{ id: string }>("SELECT gen_random_uuid()::text AS id"))!.id;
        // Files are kept apart per hospital in storage too.
        const key = `${tx.fid}/${id}/${docId}`;
        const safeName = `${fileName.replace(/[^\w.\- ()]/g, "_").replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${type.ext}`;
        await files.put(key, data);
        const row = await tx.queryOne(
          `INSERT INTO "EncounterDocument" (id, "facilityId", "encounterId", "patientId", kind, title, "fileName", "contentType", "sizeBytes", "storageKey", "uploadedBy")
           VALUES ($1, :fid, $2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${DOC_COLUMNS}`,
          [docId, id, stay.patientId, kind, title, safeName, type.type, data.length, key, actorOf(req)],
        );
        await recordAudit(tx, actorOf(req), "Document Attached", `${title} (${kind}, ${Math.round(data.length / 1024)} KB)`);
        return row;
      }),
    );
  });

  router.get("/documents/:id/file", docRoles, async (req, res) => {
    const doc = await db.queryOne<{ id: string; title: string; fileName: string; contentType: string; storageKey: string; removed: boolean }>(
      'SELECT id, title, "fileName", "contentType", "storageKey", removed FROM "EncounterDocument" WHERE "facilityId" = :fid AND id = $1',
      [uuidParam(req)],
    );
    if (!doc || (doc.removed && staffOf(req).role !== "admin")) throw notFound("Document");
    const data = await files.get(doc.storageKey);
    if (!data) throw new AppError(404, "NOT_FOUND", "The file for this document could not be found in storage");
    await recordAudit(db, actorOf(req), "Document Viewed", doc.title);
    res.setHeader("Content-Type", doc.contentType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(data);
  });

  router.post("/documents/:id/remove", requireRole("doctor", "admin"), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    res.json(
      await db.transaction(async (tx) => {
        const doc = await tx.queryOne<{ title: string; removed: boolean }>('SELECT title, removed FROM "EncounterDocument" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE', [
          uuidParam(req),
        ]);
        if (!doc) throw notFound("Document");
        if (doc.removed) throw conflict("That document is already removed");
        const row = await tx.queryOne(
          `UPDATE "EncounterDocument" SET removed = true, "removedBy" = $2, "removedAt" = now(), "removeReason" = $3 WHERE "facilityId" = :fid AND id = $1 RETURNING ${DOC_COLUMNS}`,
          [uuidParam(req), actorOf(req), reason],
        );
        await recordAudit(tx, actorOf(req), "Document Removed", `${doc.title}: ${reason}`);
        return row;
      }),
    );
  });

  return router;
}

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { rateLimit } from "../../../common/middlewares/rateLimit.middleware.js";
import type { HospitalContext } from "../../context.js";
import { parse } from "../../shared/validate.js";
import { allergyConflict } from "../ai/clinical-text.js";
import { findEncounter } from "../encounters/encounters.repository.js";
import { findPatient } from "../patients/patients.repository.js";

/** Medicine search and checking for the prescription forms. Read-only: nothing here changes a record. */
export function drugsRouter({ env, db, drugs }: HospitalContext): Router {
  const router = Router();

  // The search box asks as people type (after a short pause), so allow plenty, but not unlimited.
  const searchLimit: RequestHandler = env.rateLimitEnabled
    ? rateLimit({ windowMs: 60_000, max: 300, key: (req) => `drug-search:${req.ip}`, message: "Searching too fast. Please wait a moment." })
    : (_req, _res, next) => next();

  router.get("/search", searchLimit, async (req, res) => {
    const { q } = parse(z.object({ q: z.string().max(80).default("") }), req.query);
    res.json(await drugs.search(q));
  });

  // What a typed medicine name is, and (when a visit is given) whether it clashes with this patient's recorded allergies
  // or is already on the visit's prescription. A warning for the prescriber; it never blocks anything.
  router.get("/check", searchLimit, async (req, res) => {
    const { name, encounterId } = parse(z.object({ name: z.string().trim().min(1).max(120), encounterId: z.uuid().optional() }), req.query);
    const check = await drugs.verify(name);
    let allergyWarning: string | null = null;
    let alreadyPrescribed = false;
    if (encounterId) {
      const encounter = await findEncounter(db, encounterId);
      const patient = encounter ? await findPatient(db, encounter.patientId) : null;
      if (patient) allergyWarning = allergyConflict(name, patient.allergies, check.generic ?? "");
      if (encounter) {
        const given = await db.query<{ drugName: string }>('SELECT "drugName" FROM "Prescription" WHERE "facilityId" = :fid AND "encounterId" = $1', [encounterId]);
        const typed = name.toLowerCase().split(/[\s(]/)[0] ?? "";
        alreadyPrescribed = typed.length >= 4 && given.some((p) => p.drugName.toLowerCase().includes(typed));
      }
    }
    res.json({ name, ...check, allergyWarning, alreadyPrescribed });
  });

  return router;
}

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { rateLimit } from "../../../common/middlewares/rateLimit.middleware.js";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { structureDictation, suggestPrescription } from "../ai/consult-assist.js";
import { draftDischargeSummary } from "./discharge-draft.js";
import {
  admitDirectSchema, admitFromSchema, checkInErSchema, checkInOpdSchema, dischargeSchema, erDispositionSchema, listEncountersSchema, orderSchema, prescriptionSchema,
  soapSchema, transferBedSchema, triageSchema, vitalsSchema,
} from "./encounters.schemas.js";
import {
  addOrder, addPrescription, addVitals, admitDirect, admitFromEncounter, changeTriage, checkInEr, checkInOpd, closeOpd, dischargeIpd, getEncounterDetail,
  listEncounterDetails, listEncounterRows, resolveEr, saveSoapNote, startConsult, transferBed,
} from "./encounters.service.js";

/**
 * Visits: OPD consultations, emergency cases and inpatient stays.
 *
 * OPD:  POST /opd -> POST /:id/start -> notes, vitals, prescriptions, orders -> POST /:id/close  (or /:id/admit)
 * ER:   POST /er  -> notes, vitals, prescriptions, orders, PATCH /:id/triage -> POST /:id/er-disposition  (or /:id/admit)
 * IPD:  POST /:id/admit (from OPD/ER) or POST /ipd -> care -> POST /:id/discharge
 */
export function encountersRouter({ db, env, log, drugs }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { detail, ...filters } = parse(listEncountersSchema, req.query);
    res.json(detail === "true" ? await listEncounterDetails(db, filters) : await listEncounterRows(db, filters));
  });

  router.get("/:id", async (req, res) => {
    res.json(await getEncounterDetail(db, uuidParam(req)));
  });

  // ---- start a visit
  router.post("/opd", async (req, res) => {
    res.status(201).json(await checkInOpd(db, parse(checkInOpdSchema, req.body), actorOf(req)));
  });
  router.post("/er", async (req, res) => {
    res.status(201).json(await checkInEr(db, parse(checkInErSchema, req.body), actorOf(req)));
  });
  router.post("/ipd", async (req, res) => {
    res.status(201).json(await admitDirect(db, parse(admitDirectSchema, req.body), actorOf(req)));
  });
  router.post("/:id/start", async (req, res) => {
    res.json(await startConsult(db, uuidParam(req), actorOf(req)));
  });

  // ---- record care
  router.put("/:id/soap", async (req, res) => {
    res.json(await saveSoapNote(db, uuidParam(req), parse(soapSchema, req.body), actorOf(req)));
  });
  router.post("/:id/vitals", async (req, res) => {
    res.status(201).json(await addVitals(db, uuidParam(req), parse(vitalsSchema, req.body), actorOf(req)));
  });
  router.post("/:id/prescriptions", async (req, res) => {
    res.status(201).json(await addPrescription(db, uuidParam(req), parse(prescriptionSchema, req.body), actorOf(req)));
  });
  router.post("/:id/orders", async (req, res) => {
    res.status(201).json(await addOrder(db, uuidParam(req), parse(orderSchema, req.body), actorOf(req)));
  });
  router.patch("/:id/triage", async (req, res) => {
    res.json(await changeTriage(db, uuidParam(req), parse(triageSchema, req.body).triageLevel, actorOf(req)));
  });

  // ---- finish a visit
  router.post("/:id/close", async (req, res) => {
    res.json(await closeOpd(db, uuidParam(req), actorOf(req)));
  });
  router.post("/:id/er-disposition", async (req, res) => {
    res.json(await resolveEr(db, uuidParam(req), parse(erDispositionSchema, req.body), actorOf(req)));
  });
  router.post("/:id/admit", async (req, res) => {
    res.status(201).json(await admitFromEncounter(db, uuidParam(req), parse(admitFromSchema, req.body), actorOf(req)));
  });

  // ---- The doctor's AI assistant. Both only DRAFT: nothing here changes the record. ------------------------------
  // Each call can cost money, so they are limited per address when rate limiting is on.
  const aiLimit: RequestHandler = env.rateLimitEnabled
    ? rateLimit({ windowMs: 60 * 60_000, max: 120, key: (req) => `ai-ip:${req.ip}`, message: "Too many AI requests this hour. Please try again later." })
    : (_req, _res, next) => next();
  const doctors = requireRole("doctor", "admin");

  // Spoken words (as text) -> the note's fields, plus any vitals or tests that were said.
  router.post("/:id/ai/dictation", doctors, aiLimit, async (req, res) => {
    const { transcript } = parse(z.object({ transcript: z.string().trim().min(1).max(8000) }), req.body);
    res.json(await structureDictation(db, env, log, uuidParam(req), transcript, actorOf(req)));
  });

  // The note on screen -> suggested medicines to review (with allergy / duplicate / pharmacy checks done by the system).
  router.post("/:id/ai/prescription-suggestions", doctors, aiLimit, async (req, res) => {
    const note = parse(
      z.object({
        subjective: z.string().max(4000).optional(),
        objective: z.string().max(4000).optional(),
        assessment: z.string().max(4000).optional(),
        plan: z.string().max(4000).optional(),
      }),
      req.body ?? {},
    );
    const fields: { subjective?: string; objective?: string; assessment?: string; plan?: string } = {};
    for (const key of ["subjective", "objective", "assessment", "plan"] as const) if (note[key] !== undefined) fields[key] = note[key];
    res.json(await suggestPrescription(db, env, log, drugs, uuidParam(req), fields, actorOf(req)));
  });

  // A draft only: the clinician reviews, edits and signs it off with POST /:id/discharge.
  router.post("/:id/discharge-draft", async (req, res) => {
    res.json(await draftDischargeSummary(db, env, log, uuidParam(req), actorOf(req)));
  });
  router.post("/:id/transfer-bed", async (req, res) => {
    res.json(await transferBed(db, uuidParam(req), parse(transferBedSchema, req.body), actorOf(req)));
  });
  router.post("/:id/discharge", async (req, res) => {
    res.json(await dischargeIpd(db, uuidParam(req), parse(dischargeSchema, req.body).summary, actorOf(req)));
  });

  return router;
}

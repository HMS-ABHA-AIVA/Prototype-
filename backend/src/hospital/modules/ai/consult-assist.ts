import { z } from "zod";
import type { HospitalEnv } from "../../config.js";
import type { Database, Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { AppError, notFound } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import type { DrugLookup } from "../drugs/drug-lookup.js";
import { findEncounter } from "../encounters/encounters.repository.js";
import { isActive, toEncounterDetail } from "../encounters/encounters.service.js";
import { findPatient } from "../patients/patients.repository.js";
import { aiEnabled, askModel, extractJson } from "./ai-client.js";
import { allergyConflict, FREQUENCIES, hideIdentifiers, normaliseFrequency, splitDictation } from "./clinical-text.js";

/**
 * The doctor's AI assistant on the consultation screen:
 *  1. dictation: spoken words (already turned into text by the browser) are sorted into the note's fields;
 *  2. prescription suggestions: a draft list of medicines for the doctor to review.
 *
 * Neither changes the record. The doctor reads the result, edits it, and only then saves it through the normal calls.
 * Privacy: nothing that identifies the patient (name, MRN, phone, ABHA number) is ever sent to the model.
 */
export interface NoteFields {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface DictationResult {
  sections: NoteFields;
  vitals: { tempF?: number; pulse?: number; bp?: string; spo2?: number; rr?: number };
  orders: { type: "lab" | "radiology"; name: string }[];
  /** 'ai' = a model organised it; 'rules' = sorted by spoken section words (works without an AI key). */
  source: "ai" | "rules";
}

export interface PrescriptionSuggestion {
  drugName: string;
  dose: string;
  frequency: (typeof FREQUENCIES)[number];
  duration: string;
  rationale: string;
  /** Set when the patient's recorded allergies conflict with this medicine. Shown prominently; the doctor decides. */
  allergyWarning: string | null;
  /** True when the same medicine is already on this visit's prescription. */
  alreadyPrescribed: boolean;
  /**
   * Whether the name is a medicine in the Indian brand list, this pharmacy or RxNorm. false = not found anywhere (a
   * possibly made-up or misspelt name); null = not in the local lists and the online check could not be made.
   */
  recognised: boolean | null;
  /** Whether the hospital pharmacy lists it, and how many are in stock. */
  pharmacy: { listed: boolean; stock: number | null; unit: string | null };
}

export interface SuggestionResult {
  suggestions: PrescriptionSuggestion[];
  advice: string;
  source: "ai";
  disclaimer: string;
}

const DISCLAIMER = "AI-generated suggestions for the doctor to review. They are not medical advice and are not part of the record until the doctor adds them.";

// ---- shared loading and checks ---------------------------------------------------------------------

async function loadContext(db: Queryable, encounterId: string) {
  const row = await findEncounter(db, encounterId);
  if (!row) throw notFound("Encounter");
  if (!isActive(row)) throw new AppError(409, "ENCOUNTER_CLOSED", `This ${row.type} visit is already ${row.status}`);
  const patient = await findPatient(db, row.patientId);
  if (!patient) throw notFound("Patient");
  return { row, patient, detail: await toEncounterDetail(db, row) };
}

function requireAi(env: HospitalEnv): void {
  if (!aiEnabled(env)) {
    throw new AppError(409, "AI_NOT_CONFIGURED", "The AI assistant is not switched on for this hospital. Ask an administrator to set it up.");
  }
}

const sectionText = z.string().trim().max(4000).catch("");

// ---- 1. dictation ---------------------------------------------------------------------------------

const dictationSchema = z.object({
  subjective: sectionText.default(""),
  objective: sectionText.default(""),
  assessment: sectionText.default(""),
  plan: sectionText.default(""),
  vitals: z
    .object({
      tempF: z.number().min(80).max(115).optional(),
      pulse: z.number().int().min(20).max(250).optional(),
      bp: z.string().regex(/^\d{2,3}\/\d{2,3}$/).optional(),
      spo2: z.number().int().min(50).max(100).optional(),
      rr: z.number().int().min(4).max(80).optional(),
    })
    .partial()
    .catch({})
    .default({}),
  orders: z.array(z.object({ type: z.enum(["lab", "radiology"]), name: z.string().trim().min(1).max(120) })).max(10).catch([]).default([]),
});

const DICTATION_PROMPT = `You help a doctor write a consultation note. The doctor spoke; the text below is an automatic transcript, so it may
contain speech-recognition mistakes and missing punctuation. Sort what was said into a JSON object with exactly these keys:
{"subjective": string, "objective": string, "assessment": string, "plan": string,
 "vitals": {"tempF"?: number, "pulse"?: number, "bp"?: "120/80", "spo2"?: number, "rr"?: number},
 "orders": [{"type": "lab" | "radiology", "name": string}]}
Rules: use ONLY what the doctor said; never invent findings, diagnoses, numbers or medicines. Keep the doctor's own meaning and
wording, fixing only obvious transcription errors and punctuation. subjective = symptoms and history; objective = examination
findings; assessment = diagnosis or impression; plan = treatment, advice and follow-up. Use an empty string for anything not
mentioned. Put vitals in "vitals" only if numbers were stated (convert Celsius to Fahrenheit). Add "orders" only for tests the doctor
says to order or advise. Do not put medicine prescriptions in "orders". Reply with the JSON object only.`;

/** Keeps only the vitals the model actually gave (exact optional types: no explicit undefined). */
function definedVitals(v: { tempF?: number | undefined; pulse?: number | undefined; bp?: string | undefined; spo2?: number | undefined; rr?: number | undefined }) {
  const out: DictationResult["vitals"] = {};
  if (v.tempF !== undefined) out.tempF = v.tempF;
  if (v.pulse !== undefined) out.pulse = v.pulse;
  if (v.bp !== undefined) out.bp = v.bp;
  if (v.spo2 !== undefined) out.spo2 = v.spo2;
  if (v.rr !== undefined) out.rr = v.rr;
  return out;
}

export async function structureDictation(
  db: Database,
  env: HospitalEnv,
  log: Logger,
  encounterId: string,
  transcript: string,
  actor: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DictationResult> {
  const { patient } = await loadContext(db, encounterId);
  const clean = hideIdentifiers(transcript, patient);

  let result: DictationResult | null = null;
  if (aiEnabled(env)) {
    try {
      const answer = extractJson(await askModel(env, { system: DICTATION_PROMPT, user: `Transcript:\n${clean}`, maxTokens: 900 }, fetchImpl));
      const parsed = dictationSchema.safeParse(answer);
      if (parsed.success) {
        const { vitals, orders, ...sections } = parsed.data;
        result = { sections, vitals: definedVitals(vitals), orders, source: "ai" };
      }
    } catch (error) {
      log.warn("AI dictation structuring failed; sorting by section words instead", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  result ??= splitDictation(transcript);

  await recordAudit(db, actor, "Dictation Sorted Into Note Fields", `${encounterId} (${result.source})`);
  return result;
}

// ---- 2. prescription suggestions ------------------------------------------------------------------

const suggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        drugName: z.string().trim().min(2).max(120),
        dose: z.string().trim().min(1).max(60),
        frequency: z.string().trim().min(1).max(40),
        duration: z.string().trim().min(1).max(40),
        rationale: z.string().trim().max(400).catch(""),
      }),
    )
    .max(8),
  advice: z.string().trim().max(800).catch("").default(""),
});

const SUGGEST_PROMPT = `You assist a licensed doctor in India by drafting a SUGGESTED prescription for the doctor to review. You are given the
consultation note and the patient's age, sex, recorded allergies, problems and current medicines. Reply with a JSON object only:
{"suggestions": [{"drugName": string, "dose": string, "frequency": "OD" | "BD" | "TDS" | "QID" | "SOS", "duration": string, "rationale": string}],
 "advice": string}
Rules: suggest only medicines that fit what the note says; prefer common generic names and strengths (for example "Paracetamol 500mg");
dose is per administration (for example "1 tab"); duration like "5 days". Never suggest a medicine the patient is allergic to, or one
already prescribed. Take age and recorded problems into account (for example children's doses, kidney disease). If the note does not
support any medicine, return an empty list and say why in "advice". "rationale" is one short sentence linking the medicine to the note.
"advice" is brief non-drug advice. Maximum 6 suggestions. This is a draft: the doctor decides.`;

export async function suggestPrescription(
  db: Database,
  env: HospitalEnv,
  log: Logger,
  drugs: DrugLookup,
  encounterId: string,
  note: Partial<NoteFields>,
  actor: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SuggestionResult> {
  requireAi(env);
  const { patient, detail } = await loadContext(db, encounterId);

  // The note on screen (it may not be saved yet) wins; the saved note is the fallback.
  const saved = detail.soap;
  const text: NoteFields = {
    subjective: (note.subjective ?? saved?.subjective ?? "").trim(),
    objective: (note.objective ?? saved?.objective ?? "").trim(),
    assessment: (note.assessment ?? saved?.assessment ?? "").trim(),
    plan: (note.plan ?? saved?.plan ?? "").trim(),
  };
  if (!Object.values(text).some(Boolean)) {
    throw new AppError(400, "NOTE_EMPTY", "Write or dictate the consultation note first; the suggestions are based on it.");
  }

  const latest = detail.vitals[detail.vitals.length - 1];
  const facts = {
    age: patient.yearOfBirth ? new Date().getFullYear() - patient.yearOfBirth : null,
    sex: patient.gender,
    allergies: patient.allergies,
    knownProblems: patient.problemList,
    consultationNote: Object.fromEntries(Object.entries(text).map(([k, v]) => [k, hideIdentifiers(v, patient)])),
    latestVitals: latest ? { tempF: latest.tempF, pulse: latest.pulse, bp: latest.bp, spo2: latest.spo2, rr: latest.rr } : null,
    alreadyPrescribedThisVisit: detail.prescriptions.map((p) => p.drugName),
  };

  let answer: unknown;
  try {
    answer = extractJson(await askModel(env, { system: SUGGEST_PROMPT, user: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}`, maxTokens: 1100 }, fetchImpl));
  } catch (error) {
    log.warn("AI prescription suggestion failed", { message: error instanceof Error ? error.message : String(error) });
    throw new AppError(502, "AI_UNAVAILABLE", "The AI assistant could not be reached just now. Please try again, or write the prescription yourself.");
  }
  const parsed = suggestionSchema.safeParse(answer);
  if (!parsed.success) {
    throw new AppError(502, "AI_BAD_RESPONSE", "The AI assistant gave an answer that could not be read. Please try again, or write the prescription yourself.");
  }

  // Checks done by the system, not the model: allergies, duplicates and what the pharmacy actually stocks.
  const formulary = await db.query<{ name: string; stock: number; unit: string }>(
    `SELECT d.name, COALESCE((SELECT sum(b.qty) FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id
                                AND b.expiry >= (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS stock, d.unit
       FROM "Drug" d WHERE d."facilityId" = :fid`,
  );
  const already = detail.prescriptions.map((p) => p.drugName.toLowerCase());
  const names = await Promise.all(parsed.data.suggestions.map((s) => drugs.verify(s.drugName)));
  const suggestions: PrescriptionSuggestion[] = parsed.data.suggestions.map((s, i) => {
    const key = s.drugName.toLowerCase().split(/[\s(]/)[0] ?? "";
    const listed = key.length >= 4 ? formulary.find((d) => d.name.toLowerCase().includes(key)) : undefined;
    const name = names[i]!;
    return {
      drugName: s.drugName,
      dose: s.dose,
      frequency: normaliseFrequency(s.frequency),
      duration: s.duration,
      rationale: s.rationale,
      // A brand's own name says nothing about its family, so the generic composition is checked too.
      allergyWarning: allergyConflict(s.drugName, patient.allergies, name.generic ?? ""),
      alreadyPrescribed: key.length >= 4 && already.some((a) => a.includes(key)),
      recognised: name.recognised,
      pharmacy: { listed: !!listed, stock: listed?.stock ?? null, unit: listed?.unit ?? null },
    };
  });

  await recordAudit(db, actor, "AI Prescription Suggestions Generated", `${encounterId}: ${suggestions.length} suggestion(s)`);
  return { suggestions, advice: parsed.data.advice, source: "ai", disclaimer: DISCLAIMER };
}

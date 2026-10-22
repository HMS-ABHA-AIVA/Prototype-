import type { HospitalEnv } from "../../config.js";
import type { Database } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, notFound } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { aiEnabled, askModel } from "../ai/ai-client.js";
import { findPatient } from "../patients/patients.repository.js";
import { findEncounter } from "./encounters.repository.js";
import { toEncounterDetail } from "./encounters.service.js";

/**
 * Drafts an inpatient discharge summary for a clinician to review and sign. It is only ever a DRAFT: nothing here
 * changes the record; the clinician edits it and signs it off through the normal discharge call.
 *
 * With ANTHROPIC_API_KEY set the drafting is done by a Claude model; without it (or if that call fails) a plain
 * template is produced from the same facts, so the screen always works.
 *
 * Privacy: the facts sent to the model contain NO name, MRN, phone, ABHA number or address: only age, sex and the
 * clinical content. The identifying header line is added here, after the model has answered.
 */
export interface DischargeFacts {
  age: number | null;
  sex: string | null;
  department: string;
  admittedOn: string | null;
  daysInHospital: number | null;
  problems: string[];
  allergies: string[];
  consultationNote: { subjective: string; objective: string; assessment: string; plan: string } | null;
  latestVitals: { tempF: number | null; pulse: number | null; bp: string | null; spo2: number | null; rr: number | null } | null;
  investigations: string[];
  medications: string[];
}

const DRAFT_BANNER = "DISCHARGE SUMMARY (AI DRAFT — requires clinician review before finalizing)";
const FOOTER = "— AI-generated draft. Edit and sign off before adding to the medical record.";

const SYSTEM_PROMPT = `You help a hospital clinician draft an inpatient discharge summary. You are given structured clinical facts only.
Write a concise, plain-text summary with these headings: Diagnosis / Problems, Allergies, Course in Hospital, Investigations,
Medications on Discharge, Follow-up. Use ONLY the facts provided. Do not invent diagnoses, results, doses or dates. If something
is not documented, write "Not documented". Do not add patient names or identifiers. Keep it under 300 words.`;

export function templateDraft(facts: DischargeFacts): string {
  const vitals = facts.latestVitals;
  const note = facts.consultationNote;
  return [
    `Department: ${facts.department}`,
    `Admitted: ${facts.admittedOn ?? "-"}${facts.daysInHospital != null ? ` (${facts.daysInHospital} day(s) in hospital)` : ""}`,
    "",
    `Diagnosis / Problem List: ${facts.problems.join(", ") || note?.assessment || "Not documented"}`,
    `Allergies: ${facts.allergies.join(", ") || "NKDA"}`,
    "",
    `Course in Hospital: Patient was admitted and managed per department protocol. ${facts.investigations.length} investigation(s) ordered.` +
      (vitals ? ` Vitals at last recording: Temp ${vitals.tempF ?? "-"}°F, BP ${vitals.bp ?? "-"}, SpO2 ${vitals.spo2 ?? "-"}%.` : ""),
    note?.plan ? `Plan noted: ${note.plan}` : "",
    "",
    `Investigations: ${facts.investigations.join("; ") || "None recorded"}`,
    `Medications on Discharge: ${facts.medications.join("; ") || "None recorded"}`,
    "",
    "Follow-up: Advised OPD follow-up in 7 days.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

export async function draftDischargeSummary(
  db: Database,
  env: HospitalEnv,
  log: Logger,
  encounterId: string,
  actor: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ draft: string; source: "ai" | "template" }> {
  const row = await findEncounter(db, encounterId);
  if (!row) throw notFound("Encounter");
  if (row.type !== "IPD") throw badRequest("A discharge summary is drafted for inpatient stays only");
  const patient = await findPatient(db, row.patientId);
  if (!patient) throw notFound("Patient");
  const encounter = await toEncounterDetail(db, row);

  const latest = encounter.vitals[encounter.vitals.length - 1];
  const admitted = row.admittedAt ? new Date(row.admittedAt) : null;
  const facts: DischargeFacts = {
    age: patient.yearOfBirth ? new Date().getFullYear() - patient.yearOfBirth : null,
    sex: patient.gender,
    department: row.department,
    admittedOn: admitted ? admitted.toISOString().slice(0, 10) : null,
    daysInHospital: admitted ? Math.max(1, Math.ceil((Date.now() - admitted.getTime()) / 86_400_000)) : null,
    problems: patient.problemList,
    allergies: patient.allergies,
    consultationNote: encounter.soap,
    latestVitals: latest ? { tempF: latest.tempF, pulse: latest.pulse, bp: latest.bp, spo2: latest.spo2, rr: latest.rr } : null,
    investigations: encounter.orders.filter((o) => o.status !== "cancelled").map((o) => `${o.type}: ${o.name}`),
    medications: encounter.prescriptions.map((p) => `${p.drugName} ${p.dose} ${p.frequency} x ${p.duration}`),
  };

  let body = "";
  let source: "ai" | "template" = "template";
  if (aiEnabled(env)) {
    try {
      body = await askModel(env, { system: SYSTEM_PROMPT, user: `Clinical facts (JSON):\n${JSON.stringify(facts, null, 2)}`, maxTokens: 900 }, fetchImpl);
      source = "ai";
    } catch (error) {
      log.warn("AI discharge draft failed; using the template", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (source === "template") body = templateDraft(facts);

  // The identifying line is added here, locally; it was never part of what the model saw.
  const header = `${DRAFT_BANNER}\n\nPatient: ${patient.name}, ${facts.age ?? "-"}${patient.gender ?? ""} | MRN: ${patient.mrn}`;
  await recordAudit(db, actor, "AI Discharge Draft Generated", `${encounterId} (${source})`);
  return { draft: `${header}\n\n${body}\n\n${FOOTER}`, source };
}

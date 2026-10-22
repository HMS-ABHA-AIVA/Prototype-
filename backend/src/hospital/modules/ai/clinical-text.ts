import type { DictationResult, NoteFields } from "./consult-assist.js";

/**
 * Plain, rule-based helpers around the AI assistant: no model involved, so they behave the same every time and can be
 * checked by reading them. The safety-relevant ones (allergies, removing identifiers) deliberately do NOT rely on the AI.
 */

// ---- frequencies -----------------------------------------------------------------------------------

export const FREQUENCIES = ["OD", "BD", "TDS", "QID", "SOS"] as const;

/** Maps what a model (or a person) wrote to one of the codes the prescription form uses. Unknown wording becomes OD. */
export function normaliseFrequency(text: string): (typeof FREQUENCIES)[number] {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (/\b(sos|prn)\b|as needed|when required|if required/.test(t)) return "SOS";
  if (/\b(qid|qds)\b|four times|4 times|1-1-1-1/.test(t)) return "QID";
  if (/\b(tds|tid)\b|thrice|three times|3 times|1-1-1/.test(t)) return "TDS";
  if (/\b(bd|bid)\b|twice|two times|2 times|1-0-1/.test(t)) return "BD";
  return "OD";
}

// ---- allergies -------------------------------------------------------------------------------------

/** Medicine families that share an allergy. Not exhaustive: it supplements the doctor's judgement, it never replaces it. */
const FAMILIES: { names: string[]; drugs: string[]; prefixes?: string[] }[] = [
  {
    names: ["penicillin", "beta-lactam", "beta lactam"],
    drugs: ["penicillin", "amoxicillin", "amoxycillin", "ampicillin", "cloxacillin", "flucloxacillin", "piperacillin", "amoxiclav", "co-amoxiclav", "augmentin", "benzathine", "dicloxacillin"],
  },
  { names: ["cephalosporin"], drugs: [], prefixes: ["cef", "ceph"] },
  {
    names: ["sulfa", "sulpha", "sulfonamide", "sulphonamide", "cotrimoxazole", "co-trimoxazole"],
    drugs: ["sulfa", "sulpha", "sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "trimethoprim", "septran", "bactrim", "sulfasalazine"],
  },
  {
    names: ["nsaid", "nsaids", "aspirin", "ibuprofen", "diclofenac"],
    drugs: ["ibuprofen", "diclofenac", "naproxen", "aspirin", "ketorolac", "nimesulide", "etoricoxib", "celecoxib", "mefenamic", "piroxicam", "indomethacin", "aceclofenac"],
  },
  { names: ["macrolide", "azithromycin", "erythromycin"], drugs: ["azithromycin", "clarithromycin", "erythromycin", "roxithromycin"] },
  { names: ["quinolone", "fluoroquinolone", "ciprofloxacin"], drugs: ["ciprofloxacin", "levofloxacin", "ofloxacin", "moxifloxacin", "norfloxacin", "gatifloxacin"] },
  { names: ["opioid", "codeine", "morphine", "tramadol"], drugs: ["codeine", "morphine", "tramadol", "tapentadol", "pethidine"] },
];

/**
 * A warning when the recorded allergies point at this medicine (by name or by family), otherwise null.
 * `alsoKnownAs` is what a brand is made of ("Amoxycillin (500mg)"): a brand name such as Augmentin or Taxim-O says nothing
 * about the family on its own, so the generic composition is checked as well.
 */
export function allergyConflict(drugName: string, allergies: string[], alsoKnownAs = ""): string | null {
  const drug = `${drugName} ${alsoKnownAs}`.toLowerCase();
  for (const raw of allergies) {
    const allergy = raw.toLowerCase().trim();
    if (allergy.length < 3) continue;
    if (allergy.length >= 4 && drug.includes(allergy)) return `Recorded allergy: ${raw}`;
    for (const family of FAMILIES) {
      const inFamily = family.names.some((n) => allergy.includes(n) || (allergy.length >= 4 && n.includes(allergy)));
      if (!inFamily) continue;
      const hit = family.drugs.some((d) => drug.includes(d)) || (family.prefixes ?? []).some((p) => drug.split(/[\s(+/,]+/).some((word) => word.startsWith(p)));
      if (hit) return `Recorded allergy: ${raw} (${drugName} is related)`;
    }
  }
  return null;
}

// ---- identifiers -----------------------------------------------------------------------------------

/**
 * Removes what identifies the patient before text goes to a model: their name (every part of it), phone numbers, MRN and
 * ABHA numbers. Even if the doctor says the name aloud, it never leaves the system.
 */
export function hideIdentifiers(text: string, patient: { name: string; phone?: string | null }): string {
  let out = text;
  for (const part of patient.name.split(/\s+/).filter((p) => p.length >= 3)) {
    out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[patient]");
  }
  if (patient.phone) out = out.split(patient.phone).join("[phone]");
  return out
    .replace(/\b\d{10}\b/g, "[phone]")
    .replace(/\b(?:\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/g, "[id]")
    .replace(/\bMRN[- ]?\d+\b/gi, "[id]");
}

// ---- dictation without AI --------------------------------------------------------------------------

const MARKER =
  /(?<=^|[.;\n])\s*(symptoms?|complaints?|history|examination|findings?|diagnosis|impression|treatment|advice|follow[- ]?up)\b[:,]?|\b(subjective|objective|assessment|plan)\b[:,]?/gi;

const SECTION_OF: Record<string, keyof NoteFields> = {
  subjective: "subjective",
  symptom: "subjective",
  symptoms: "subjective",
  complaint: "subjective",
  complaints: "subjective",
  history: "subjective",
  objective: "objective",
  examination: "objective",
  finding: "objective",
  findings: "objective",
  assessment: "assessment",
  diagnosis: "assessment",
  impression: "assessment",
  plan: "plan",
  treatment: "plan",
  advice: "plan",
  "follow-up": "plan",
  "follow up": "plan",
  followup: "plan",
};

const tidy = (s: string) => s.replace(/^[\s,.:;-]+|[\s,;:-]+$/g, "").replace(/\s+/g, " ");
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Sorts a spoken transcript into the four note fields by the section words the doctor says ("subjective … objective …
 * assessment … plan …"). Words before the first section word go to Subjective. Also picks vitals out of phrases such as
 * "BP 120 over 80" or "pulse 82". Used when no AI is configured, or when the AI answer cannot be used.
 */
export function splitDictation(transcript: string): DictationResult {
  const sections: NoteFields = { subjective: "", objective: "", assessment: "", plan: "" };
  const add = (key: keyof NoteFields, text: string) => {
    const piece = tidy(text);
    if (piece) sections[key] = sections[key] ? `${sections[key]} ${capital(piece)}` : capital(piece);
  };

  const marks = [...transcript.matchAll(MARKER)];
  if (marks.length === 0) {
    add("subjective", transcript);
  } else {
    add("subjective", transcript.slice(0, marks[0]!.index));
    marks.forEach((m, i) => {
      const word = (m[1] ?? m[2] ?? "").toLowerCase().replace(/\s+/g, " ");
      const key = SECTION_OF[word] ?? SECTION_OF[word.replace(/[- ]/g, "")] ?? "subjective";
      const end = marks[i + 1]?.index ?? transcript.length;
      add(key, transcript.slice((m.index ?? 0) + m[0].length, end));
    });
  }

  const num = (re: RegExp) => {
    const m = transcript.match(re);
    return m?.[1] ? Number(m[1]) : undefined;
  };
  const vitals: DictationResult["vitals"] = {};
  let temp = num(/\btemp(?:erature)?\s*(?:is|of|was|:)?\s*(\d{2,3}(?:\.\d)?)/i);
  if (temp !== undefined && temp < 45) temp = (temp * 9) / 5 + 32; // spoken in Celsius
  if (temp !== undefined && temp >= 80 && temp <= 115) vitals.tempF = Math.round(temp * 10) / 10;
  const pulse = num(/\bpulse(?:\s*rate)?\s*(?:is|of|was|:)?\s*(\d{2,3})/i);
  if (pulse !== undefined && pulse >= 20 && pulse <= 250) vitals.pulse = pulse;
  const bp = transcript.match(/\b(?:bp|blood pressure)\s*(?:is|of|was|:)?\s*(\d{2,3})\s*(?:\/|over|by|upon)\s*(\d{2,3})/i);
  // Systolic above diastolic and both in a survivable range; anything else is a mishearing.
  if (bp && Number(bp[1]) >= 60 && Number(bp[1]) <= 260 && Number(bp[2]) >= 30 && Number(bp[2]) <= 160 && Number(bp[1]) > Number(bp[2])) {
    vitals.bp = `${bp[1]}/${bp[2]}`;
  }
  const spo2 = num(/\b(?:sp\s?o\s?2|oxygen saturation|saturation)\s*(?:is|of|was|:)?\s*(\d{2,3})/i);
  if (spo2 !== undefined && spo2 >= 50 && spo2 <= 100) vitals.spo2 = spo2;
  const rr = num(/\b(?:respiratory rate|resp(?:iratory)? rate|rr)\s*(?:is|of|was|:)?\s*(\d{1,2})\b/i);
  if (rr !== undefined && rr >= 4 && rr <= 80) vitals.rr = rr;

  return { sections, vitals, orders: [], source: "rules" };
}

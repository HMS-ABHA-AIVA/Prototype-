// Compares the hospital's patient record with the demographics ABDM holds for an ABHA, so an ABHA
// can't be linked to the wrong person. Only the *names of the fields that differ* are ever reported:
// the ABHA's own name/date of birth belong to whoever owns that ABHA and must not be shown to staff
// when it is not the patient in front of them.

export type AbhaMismatchField = "name" | "date of birth";

interface PatientDemographics {
  name: string;
  dateOfBirth: Date | null;
}

// What ABDM returns differs by API: `name` (profile), `firstName/middleName/lastName` (enrolment),
// and `dob` as "dd-MM-yyyy" or "yyyy-MM-dd", or separate day/month/year fields.
export interface AbhaDemographics {
  name?: unknown;
  firstName?: unknown;
  middleName?: unknown;
  lastName?: unknown;
  dob?: unknown;
  dayOfBirth?: unknown;
  monthOfBirth?: unknown;
  yearOfBirth?: unknown;
  // used to fill the hospital record (never to match)
  gender?: unknown;
  address?: unknown;
  stateName?: unknown;
  state?: unknown;
  districtName?: unknown;
  district?: unknown;
  mobile?: unknown;
}

const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "shri", "smt", "sri", "shree", "late", "master"]);

const nameTokens = (value: string): string[] =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !TITLES.has(token));

// Edit distance <= 1 (one typo / transposed-free substitution, insertion or deletion).
const withinOneEdit = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

// "full" token match: identical, or a one-letter typo in a longer name (5+ letters).
const fullMatch = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b));
// initials: "K" matches "Kumar".
const initialMatch = (a: string, b: string) => (a.length === 1 || b.length === 1) && a[0] === b[0];

/**
 * Names match when every word of the shorter name appears in the longer one (order ignored, titles ignored,
 * initials allowed), and at least one whole word matches. So "Ayush Kumar" matches "Kumar Ayush Tiwari",
 * but "A K" does not match "Ayush Kumar", and "Ayush Kumar" does not match "Rohan Verma".
 */
export const namesMatch = (recordName: string, abhaName: string): boolean => {
  const a = nameTokens(recordName);
  const b = nameTokens(abhaName);
  if (!a.length || !b.length) return false;

  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let wholeWordMatches = 0;

  for (const token of small) {
    let idx = large.findIndex((candidate, i) => !used.has(i) && fullMatch(token, candidate));
    if (idx >= 0) {
      wholeWordMatches++;
    } else {
      idx = large.findIndex((candidate, i) => !used.has(i) && initialMatch(token, candidate));
    }
    if (idx < 0) return false;
    used.add(idx);
  }

  return wholeWordMatches > 0;
};

// Stored as the name of a patient registered from an ABHA number / address alone; replaced by the ABHA's own
// name once the ABHA is linked, and never compared against the ABHA until then.
export const PENDING_PATIENT_NAME = "Name pending (from ABHA)";

export const abhaFullName = (abha: AbhaDemographics): string => {
  const joined = [abha.firstName, abha.middleName, abha.lastName].filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" ");
  if (joined) return joined;
  return typeof abha.name === "string" ? abha.name : "";
};

interface ParsedDob {
  year: number;
  month: number | undefined;
  day: number | undefined;
}

export const parseAbhaDob = (abha: AbhaDemographics): ParsedDob | null => {
  const num = (value: unknown) => {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isInteger(n) ? n : undefined;
  };

  const year = num(abha.yearOfBirth);
  if (year) return { year, month: num(abha.monthOfBirth), day: num(abha.dayOfBirth) };

  if (typeof abha.dob === "string") {
    const parts = abha.dob.trim().split(/[-/]/).map((p) => Number(p));
    if (parts.length === 1 && parts[0]! > 1800) return { year: parts[0]!, month: undefined, day: undefined };
    if (parts.length === 3 && parts.every((p) => Number.isInteger(p))) {
      const [p0, p1, p2] = parts as [number, number, number];
      return p0 > 1800 ? { year: p0, month: p1, day: p2 } : { year: p2, month: p1, day: p0 };
    }
  }

  return null;
};

const dobMatches = (record: Date, abha: ParsedDob): boolean => {
  if (record.getUTCFullYear() !== abha.year) return false;
  if (abha.month === undefined || abha.day === undefined) return true;
  // UIDAI stores year-only birth dates as 01-01-<year>; don't reject a patient whose exact date is unknown to UIDAI.
  if (abha.month === 1 && abha.day === 1) return true;
  return record.getUTCMonth() + 1 === abha.month && record.getUTCDate() === abha.day;
};

/**
 * Returns the list of fields that do not match (empty = consistent).
 * A field is only checked when both sides have it: ABDM not returning a name/DOB, or a legacy patient
 * record without a DOB, cannot produce a mismatch.
 */
export const findAbhaMismatches = (patient: PatientDemographics, abha: AbhaDemographics): AbhaMismatchField[] => {
  const mismatches: AbhaMismatchField[] = [];

  const abhaName = abhaFullName(abha);
  if (abhaName && !namesMatch(patient.name, abhaName)) mismatches.push("name");

  const abhaDob = parseAbhaDob(abha);
  if (patient.dateOfBirth && abhaDob && !dobMatches(patient.dateOfBirth, abhaDob)) mismatches.push("date of birth");

  return mismatches;
};

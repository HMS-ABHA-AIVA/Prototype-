import type { Queryable } from "../../db.js";

/**
 * A patient as the hospital modules see it. One patient table serves the whole application: the ABDM M1 module registers
 * patients and links their ABHA (Patient + AbhaPatient); OPD, emergency, IPD, pharmacy, lab and billing use the same rows.
 * The ABHA columns here are read from AbhaPatient and are never written by the hospital modules: an ABHA is only linked
 * through the ABDM flows (OTP verification, Scan & Share), which check the person's identity.
 */
export interface PatientRow {
  id: string;
  mrn: string;
  name: string;
  /** From the date of birth when it is known, else the birth year an age implied at registration. */
  yearOfBirth: number | null;
  dateOfBirth: string | null;
  gender: "M" | "F" | "O" | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  stateName: string | null;
  districtName: string | null;
  /** 14 digits, no hyphens */
  abhaNumber: string | null;
  abhaAddress: string | null;
  abhaStatus: "none" | "linked";
  allergies: string[];
  problemList: string[];
  createdAt: string;
  updatedAt: string;
}

/** Selects a PatientRow from `"Patient" p LEFT JOIN "AbhaPatient" a`. */
export const PATIENT_COLUMNS = `p.id, p.mrn, p.name,
  COALESCE(EXTRACT(YEAR FROM p."dateOfBirth")::int, p."yearOfBirth") AS "yearOfBirth", p."dateOfBirth", p.gender, NULLIF(p.phone, '') AS phone,
  p.email, p.address, p."stateName", p."districtName",
  NULLIF(regexp_replace(COALESCE(a."abhaNumber", ''), '\\D', '', 'g'), '') AS "abhaNumber", a."abhaAddress",
  CASE WHEN a.id IS NULL THEN 'none' ELSE 'linked' END AS "abhaStatus",
  p.allergies, p."problemList", p."createdAt", p."updatedAt"`;

export const PATIENT_FROM = `"Patient" p LEFT JOIN "AbhaPatient" a ON a."patientId" = p.id`;

/** The patient's birth year in other modules' SQL (`alias` is their alias for "Patient"): from the date of birth, else the age given. */
export const birthYearOf = (alias: string) => `COALESCE(EXTRACT(YEAR FROM ${alias}."dateOfBirth")::int, ${alias}."yearOfBirth")`;

export async function insertPatient(
  db: Queryable,
  p: { name: string; yearOfBirth: number | null; dateOfBirth: string | null; gender: string; phone: string | null; email: string | null; allergies: string[]; problemList: string[] },
) {
  const row = await db.queryOne<{ id: string }>(
    // createdAt / updatedAt of this (original hmsmerge) table hold UTC without a time zone, as Prisma writes them
    `INSERT INTO "Patient" ("facilityId", name, phone, email, "dateOfBirth", "yearOfBirth", gender, allergies, "problemList", "createdAt", "updatedAt")
     VALUES (:fid, $1, $2, $3, $4, $5, $6, $7, $8, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
    [p.name, p.phone ?? "", p.email, p.dateOfBirth, p.yearOfBirth, p.gender, p.allergies, p.problemList],
  );
  return findPatient(db, row!.id);
}

export function findPatient(db: Queryable, id: string) {
  return db.queryOne<PatientRow>(`SELECT ${PATIENT_COLUMNS} FROM ${PATIENT_FROM} WHERE p."facilityId" = :fid AND p.id = $1`, [id]);
}

/** Search by name, MRN, mobile, ABHA number or ABHA address. Newest registrations first. */
export function searchPatients(db: Queryable, search: string | undefined, limit: number) {
  if (!search) {
    return db.query<PatientRow>(`SELECT ${PATIENT_COLUMNS} FROM ${PATIENT_FROM} WHERE p."facilityId" = :fid ORDER BY p."createdAt" DESC LIMIT $1`, [limit]);
  }
  const like = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = search.replace(/\D/g, "");
  return db.query<PatientRow>(
    `SELECT ${PATIENT_COLUMNS} FROM ${PATIENT_FROM}
      WHERE p."facilityId" = :fid
        AND (lower(p.name) LIKE $1 OR lower(p.mrn) LIKE $1 OR p.phone LIKE $1 OR lower(a."abhaAddress") LIKE $1
             OR ($2 <> '' AND regexp_replace(COALESCE(a."abhaNumber", ''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
      ORDER BY p."createdAt" DESC LIMIT $3`,
    [like, digits.length >= 4 ? digits : "", limit],
  );
}

export async function updatePatient(db: Queryable, id: string, fields: { name?: string; phone?: string; allergies?: string[]; problemList?: string[] }) {
  const count = await db.execute(
    `UPDATE "Patient" SET
        name          = COALESCE($2, name),
        phone         = COALESCE($3, phone),
        allergies     = COALESCE($4, allergies),
        "problemList" = COALESCE($5, "problemList"),
        "updatedAt"   = now() AT TIME ZONE 'UTC'
      WHERE "facilityId" = :fid AND id = $1`,
    [id, fields.name ?? null, fields.phone ?? null, fields.allergies ?? null, fields.problemList ?? null],
  );
  return count ? findPatient(db, id) : null;
}

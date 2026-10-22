import type { Database } from "../../db.js";
import { formatAbhaNumber } from "../../shared/abha-number.js";
import { recordAudit } from "../../shared/audit.js";
import { AppError, badRequest, notFound } from "../../shared/errors.js";
import type { RegisterPatientInput, UpdatePatientInput } from "./patients.schemas.js";
import { findPatient, insertPatient, searchPatients, updatePatient, type PatientRow } from "./patients.repository.js";

/** What the API returns for a patient: the row plus values derived from it. */
export function toPatientDto(row: PatientRow) {
  return {
    ...row,
    age: row.yearOfBirth ? new Date().getFullYear() - row.yearOfBirth : null,
    abhaNumberFormatted: formatAbhaNumber(row.abhaNumber),
  };
}
export type PatientDto = ReturnType<typeof toPatientDto>;

export async function registerPatient(db: Database, input: RegisterPatientInput, actor: string): Promise<PatientDto> {
  if (input.age === undefined && input.yearOfBirth === undefined && input.dateOfBirth === undefined) {
    throw badRequest("Give the age, the year of birth or the date of birth");
  }
  const yearOfBirth = input.dateOfBirth ? Number(input.dateOfBirth.slice(0, 4)) : input.yearOfBirth ?? new Date().getFullYear() - input.age!;

  return db.transaction(async (tx) => {
    const row = await insertPatient(tx, {
      name: input.name,
      yearOfBirth,
      dateOfBirth: input.dateOfBirth ?? null,
      gender: input.gender,
      phone: input.phone ?? null,
      email: input.email ?? null,
      allergies: input.allergies,
      problemList: input.problemList,
    });
    await recordAudit(tx, actor, "Patient Registered", `${row!.name} (${row!.mrn})`);
    return toPatientDto(row!);
  });
}

export async function getPatient(db: Database, id: string): Promise<PatientDto> {
  const row = await findPatient(db, id);
  if (!row) throw notFound("Patient");
  return toPatientDto(row);
}

export async function listPatients(db: Database, search: string | undefined, limit: number): Promise<PatientDto[]> {
  return (await searchPatients(db, search, limit)).map(toPatientDto);
}

export async function editPatient(db: Database, id: string, input: UpdatePatientInput, actor: string): Promise<PatientDto> {
  return db.transaction(async (tx) => {
    const current = await findPatient(tx, id);
    if (!current) throw notFound("Patient");
    // Once an ABHA is linked, the name is the ABHA's verified name (ABDM M1 rule): it is not edited here.
    if (input.name !== undefined && input.name !== current.name && current.abhaStatus === "linked") {
      throw new AppError(409, "NAME_FROM_ABHA", "The name comes from the patient's ABHA and cannot be changed here");
    }
    const changes: { name?: string; phone?: string; allergies?: string[]; problemList?: string[] } = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.phone !== undefined) changes.phone = input.phone;
    if (input.allergies !== undefined) changes.allergies = input.allergies;
    if (input.problemList !== undefined) changes.problemList = input.problemList;
    const row = await updatePatient(tx, id, changes);
    if (!row) throw notFound("Patient");
    await recordAudit(tx, actor, "Patient Updated", `${row.name} (${row.mrn})`);
    return toPatientDto(row);
  });
}

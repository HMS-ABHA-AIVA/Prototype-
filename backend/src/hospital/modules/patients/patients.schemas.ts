import { z } from "zod";
import { mobileNumber } from "../../../common/validators/mobile.js";
import { dateOfBirth, patientName } from "../../../common/validators/patient.validation.js";

// Patients are registered by the same rules as the ABDM registration screen (name, mobile and date-of-birth checks).
const gender = z.enum(["M", "F", "O"]);
const clinicalItem = z.string().trim().min(1).max(120);

export const registerPatientSchema = z.object({
  name: patientName,
  /** Give age (walk-in desk), yearOfBirth, or dateOfBirth when it is known exactly. */
  age: z.number().int().min(0).max(130).optional(),
  yearOfBirth: z.number().int().min(1880).max(new Date().getFullYear()).optional(),
  dateOfBirth: dateOfBirth.optional(),
  gender,
  phone: mobileNumber.optional(),
  email: z.email("Invalid email address").max(254, "Email address is too long").optional(),
  allergies: z.array(clinicalItem).max(50).default([]),
  problemList: z.array(clinicalItem).max(50).default([]),
});
export type RegisterPatientInput = z.output<typeof registerPatientSchema>;

export const updatePatientSchema = z
  .object({
    name: patientName,
    phone: mobileNumber,
    allergies: z.array(clinicalItem).max(50),
    problemList: z.array(clinicalItem).max(50),
  })
  .partial();
export type UpdatePatientInput = z.output<typeof updatePatientSchema>;

export const searchPatientsSchema = z.object({
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

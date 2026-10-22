import { z } from "zod";
import { mobileNumber } from "./mobile.js";

// "YYYY-MM-DD" that is a real calendar date, not in the future, and not absurdly old.
// (Exported so the hospital modules register patients by the same rules.)
export const dateOfBirth = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format")
    .refine((value) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "Date of birth is not a valid date")
    .refine((value) => value <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future")
    .refine((value) => value >= "1900-01-01", "Date of birth is too far in the past");

// Whitelist: letters in any script, spaces and . ' - (rules out control characters, markup and digits).
// Trim first so the length limits apply to what is stored.
export const patientName = z.string().trim()
    .min(2, "Patient name must be at least 2 characters")
    .max(100, "Patient name cannot exceed 100 characters")
    .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’\-]*$/u, "Patient name may contain only letters, spaces and . ' -");

export const createPatientSchema = z.object({

    // Left out when the patient is registered from an ABHA number / address: the name then comes from the ABHA once it is linked.
    name: patientName.optional(),

    // Left out when the patient is registered from an ABHA number / address: the ABHA's mobile is taken once linked.
    phone: mobileNumber.optional(),

    email: z.email("Invalid email address").max(254, "Email address is too long").optional(),

    dateOfBirth: dateOfBirth.optional(),

    // M, F or O, as ABDM records it (the hospital modules need it: births, prescriptions, the chart).
    gender: z.enum(["M", "F", "O"], "Gender must be M, F or O").optional(),
}).refine((patient) => patient.name === undefined || patient.phone !== undefined, {
    path: ["phone"],
    message: "Enter the 10-digit mobile number.",
});

// Paging for the patient list: bounded so one call can never return the whole table.
export const listPatientsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1, "limit must be at least 1").max(1000, "limit can be at most 1000").default(500),
    page: z.coerce.number().int().min(1, "page must be at least 1").default(1),
});

// What staff may edit on a patient. Name, date of birth and gender are deliberately absent (and .strict() rejects
// them): once verified against an ABHA they are fixed. Empty string clears an optional field.
const optionalText = (max: number, label: string) =>
    z.string().trim().max(max, `${label} is too long`).regex(/^[^\u0000-\u001f\u007f]*$/, `${label} contains characters that are not allowed`);

export const updatePatientSchema = z.object({
    phone: mobileNumber.optional(),
    email: z.union([z.email("Invalid email address").max(254, "Email address is too long"), z.literal("")]).optional(),
    address: optionalText(300, "Address").optional(),
    stateName: optionalText(80, "State").optional(),
    districtName: optionalText(80, "District").optional(),
}).strict();

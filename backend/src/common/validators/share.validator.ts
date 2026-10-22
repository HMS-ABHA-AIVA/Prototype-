import { z } from "zod";
import { mobileNumber } from "./mobile.js";

// Counter id from the QR code (ABDM: 1 to 20 alphanumeric characters; a little leeway for spaces . _ -).
export const counterCodeSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/, "Counter id may contain only letters, digits, space . _ -");

// ABDM sends numbers as strings and "no value" as null; accept both.
const optionalString = z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined || v === "" ? null : String(v)));

// The inbound body of POST /api/v3/hip/patient/share (see NHA "scan and register").
export const inboundShareSchema = z.object({
    intent: z.literal("PROFILE_SHARE"),
    metaData: z.object({
        hipId: z.string().min(1).max(100),
        context: z.string().min(1).max(250),
    }),
    profile: z.object({
        patient: z.object({
            abhaNumber: optionalString,
            abhaAddress: z.string().trim().min(3).max(100),
            name: z.string().trim().min(1).max(200),
            gender: optionalString,
            dayOfBirth: optionalString,
            monthOfBirth: optionalString,
            yearOfBirth: z.union([z.string(), z.number()]).transform((v) => String(v)),
            address: z
                .object({
                    line: optionalString,
                    district: optionalString,
                    state: optionalString,
                    pincode: optionalString,
                })
                .nullish(),
            phoneNumber: optionalString,
        }),
    }),
});

export type InboundShare = z.infer<typeof inboundShareSchema>;

export const shareIdParamSchema = z.uuid("Invalid share ID");

// Staff may supply a different mobile number when the one on the ABHA is missing or already used by another patient.
export const registerShareSchema = z.object({
    phone: mobileNumber.optional(),
}).strict();

export const shareConfigQuerySchema = z.object({
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

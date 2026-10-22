import {z} from "zod"
import { mobileNumber } from "./mobile.js";

// The patient must have agreed to the consent text shown before any OTP is requested.
const consent = z.literal(true, "Patient consent is required before an OTP is sent");
// Language the consent text was shown in (recorded with the transaction).
const consentLanguage = z.enum(["en", "hi"], "Unsupported consent language").default("en");

export const abdmTokenRetrievalSchema = z.object({
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
});

export const aadhaarOtpRequestSchema = z.object({
    environment : z.enum(["SANDBOX","PRODUCTION"]),
    patientId: z.uuid(),
    aadhaar: z.string().regex(/^\d{12}$/, "Aadhaar number must be exactly 12 digits"),
    consent,
    consentLanguage,
});

export const aadharOtpVerifySchema = z.object({
    transactionId : z.uuid("invalid transaction ID"),
    otp : z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
    mobile : mobileNumber,
    environment : z.enum(["SANDBOX" ,  "PRODUCTION"])

})

export const existingAbhaAadhaarOtpRequestSchema = z.object({
  patientId: z.uuid("Invalid patient ID"),
  aadhaar: z.string().regex(/^\d{12}$/,"Aadhaar number must be exactly 12 digits"),
  environment: z.enum(["SANDBOX","PRODUCTION"]),
  consent,
  consentLanguage,
});

export const existingAbhaAadhaarOtpVerifySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    otp: z.string().regex(/^\d{6}$/,"OTP must be exactly 6 digits"),
    environment: z.enum(["SANDBOX","PRODUCTION"]),
  });


export const existingAbhaMobileOtpRequestSchema = z.object({
  patientId: z.uuid("Invalid patient ID"),

  mobile: mobileNumber,

  environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
  consent,
  consentLanguage,
});

export const existingAbhaMobileOtpVerifySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),

    otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d+$/, "OTP must contain only digits"),

    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

export const verifyExistingAbhaMobileUserSchema = z.object({
    abhaNumber: z.string().min(1, "ABHA number is required"),

    transactionId: z.uuid("Invalid transaction ID"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

// Profile / QR are tied to one patient: the X-token cookie is only valid for the patient it was issued for.
export const getAbhaProfileSchema = z.object({

  patientId: z.uuid("Invalid patient ID"),

  environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),

});

// --- enrolment follow-ups (after "create ABHA") ---------------------------------------------------

export const enrolMobileRequestSchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    mobile: mobileNumber,
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

export const enrolMobileVerifySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

export const abhaAddressSuggestionsQuerySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

export const createAbhaAddressSchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    abhaAddress: z.string().trim().min(8, "ABHA address must be at least 8 characters").max(60, "ABHA address is too long"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
});

// --- link an existing ABHA by ABHA number -----------------------------------------------------------

const abhaNumber = z.string().regex(/^\d{2}-?\d{4}-?\d{4}-?\d{4}$/, "ABHA number must be 14 digits (for example 91-1234-5678-9012)");
const loginChannel = z.enum(["aadhaar", "mobile"], "Choose where the OTP is sent (Aadhaar-linked mobile or ABHA mobile)");

export const abhaNumberOtpRequestSchema = z.object({
    patientId: z.uuid("Invalid patient ID"),
    abhaNumber,
    channel: loginChannel,
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
    consent,
    consentLanguage,
});

export const abhaNumberOtpVerifySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
    channel: loginChannel,
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
    // set when the patient was registered with this ABHA and a mobile number, which must then be the ABHA's own
    requireMobileMatch: z.boolean().optional(),
});

// --- update the ABHA mobile / email ---------------------------------------------------------------------

const contactBase = {
    patientId: z.uuid("Invalid patient ID"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
};

export const profileContactRequestSchema = z.discriminatedUnion("type", [
    z.object({ ...contactBase, type: z.literal("mobile"), value: mobileNumber }),
    z.object({ ...contactBase, type: z.literal("email"), value: z.email("Enter a valid email address").max(254, "Email address is too long") }),
]);

export const profileContactVerifySchema = z.object({
    ...contactBase,
    type: z.enum(["mobile", "email"], "type must be mobile or email"),
    transactionId: z.uuid("Invalid transaction ID"),
    otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
});

// --- link an existing ABHA by ABHA address (PHR login) ---------------------------------------------------

// "name", "name@sbx" (sandbox) or "name@abdm" (production): letters, digits, dot, underscore.
// An e-mail address is not an ABHA address, so a different domain is refused with a pointer to what is expected.
const abhaAddressForLogin = z
    .string()
    .trim()
    .max(60, "ABHA address is too long")
    .refine((v) => !v.includes("@") || /@(sbx|abdm)$/i.test(v), "That looks like an email address. An ABHA address ends with @sbx (sandbox) or @abdm (production), for example name@sbx")
    .refine((v) => /^[A-Za-z0-9._]{3,40}(@(sbx|abdm))?$/i.test(v), "Enter the ABHA address, for example name@sbx");

export const abhaAddressOtpRequestSchema = z.object({
    patientId: z.uuid("Invalid patient ID"),
    abhaAddress: abhaAddressForLogin,
    channel: loginChannel,
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
    consent,
    consentLanguage,
});

export const abhaAddressOtpVerifySchema = z.object({
    transactionId: z.uuid("Invalid transaction ID"),
    otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 digits"),
    channel: loginChannel,
    environment: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
    // set when the patient was registered with this ABHA and a mobile number, which must then be the ABHA's own
    requireMobileMatch: z.boolean().optional(),
});

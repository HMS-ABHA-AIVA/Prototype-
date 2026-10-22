import {z} from 'zod';
import { newPasswordSchema, rejectWeakPassword } from "./password.js";

const email = z.email("must be a valid email address").max(254, "email is too long");

// Letters (any script), digits, spaces and the punctuation real facility names use.
const facilityName = z.string().trim()
    .min(3,"must be atleast 3 characters long")
    .max(100,"name can be max 100 characters long")
    .regex(/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\-]*$/u, "name contains characters that are not allowed");

// Letters (any script), spaces and . ' - only
const personName = z.string().trim()
    .min(3,"must be atleast 3 characters long")
    .max(50,"name can be max 50 characters long")
    .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u, "name may contain only letters, spaces and . ' -");

export const registerFacilitySchema = z.object({
    name : facilityName,
    email,
    hfrId: z.string().trim().min(1, "HFR ID is required").max(30, "HFR ID is too long").regex(/^[A-Za-z0-9_-]+$/, "HFR ID may contain only letters, numbers, - and _"),
    password : newPasswordSchema,
}).superRefine(rejectWeakPassword)


export const loginFacilitySchema = z.object({
  email: z.email("Invalid email").max(254, "Invalid email"),
  password: z.string().min(1, "Password is required").max(128, "Invalid password"),
});


export const addAbdmDetailsSchema = z.object({
  clientId: z.string().trim().min(1, "Client ID is required").max(100, "Client ID is too long"),
  clientSecret: z.string().min(1, "Client secret is required").max(256, "Client secret is too long"),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
});

export const createAdminSchema = z.object({
  name : personName,
  email,
  password : newPasswordSchema,
}).superRefine(rejectWeakPassword)

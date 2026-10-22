import { z } from "zod";

// Policy for NEW passwords (facility registration, staff creation). Existing passwords keep working at login.
// NDHM secure-development guidelines: enforce length and complexity, run weak-password checks, and never allow
// the password to equal the user name.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "qwerty", "qwerty123", "qwertyuiop",
  "123456", "1234567", "12345678", "123456789", "1234567890", "0123456789", "111111", "000000", "abc123", "abcd1234",
  "admin", "admin123", "admin@123", "administrator", "welcome", "welcome1", "welcome123", "letmein", "iloveyou",
  "hospital", "hospital123", "hospital@123", "changeme", "default", "test1234", "india123", "india@123",
]);

export const newPasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password can be at most 128 characters")
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Password must contain both letters and numbers");

/** Use with `.superRefine(rejectWeakPassword)` on an object that has `email` and `password`. */
export const rejectWeakPassword = (data: { email: string; password: string }, ctx: z.RefinementCtx) => {
  const password = data.password.toLowerCase();
  const email = data.email.toLowerCase();
  const local = email.split("@")[0] ?? "";

  const weak =
    COMMON_PASSWORDS.has(password) ||
    password === email ||
    password === local ||
    (local.length >= 4 && password.includes(local)) ||
    /^(.)\1+$/.test(password);

  if (weak) {
    ctx.addIssue({
      code: "custom",
      path: ["password"],
      message: "This password is too easy to guess. Choose a different one that is not based on the e-mail address.",
    });
  }
};

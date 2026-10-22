import type { Request } from "express";
import { rateLimit } from "./rateLimit.middleware.js";

const WINDOW_MS = 15 * 60_000;

const emailOf = (req: Request): string | undefined => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email ? email.trim().toLowerCase() : undefined;
};

// Brute-force protection for the password logins: a per-IP cap, plus a per-account cap so a
// distributed attack on one e-mail is slowed down too. Counts every attempt, successful or not.
export const loginRateLimit = [
  rateLimit({
    windowMs: WINDOW_MS,
    max: 30,
    key: (req) => `login-ip:${req.ip}`,
    message: "Too many sign-in attempts from this device. Please wait 15 minutes and try again.",
  }),
  rateLimit({
    windowMs: WINDOW_MS,
    max: 8,
    key: (req) => {
      const email = emailOf(req);
      return email ? `login-acct:${req.baseUrl}:${email}` : undefined;
    },
    message: "Too many sign-in attempts for this account. Please wait 15 minutes and try again.",
  }),
];

// Facility registration is open to anyone; keep it from being used to flood the database.
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  key: (req) => `register-ip:${req.ip}`,
  message: "Too many registrations from this device. Please try again later.",
});

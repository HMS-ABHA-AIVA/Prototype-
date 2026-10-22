import { digitsOnly } from "./http.js";

/**
 * The ABDM module stores an ABHA number the way ABDM returns it (91-1234-5678-9012 or 14 digits). The hospital screens
 * show it formatted and search it by digits, so both forms are derived here.
 */
export function abhaDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = digitsOnly(value);
  return digits.length === 14 ? digits : null;
}

/** 14 digits shown as 91-1234-5678-9012. */
export function formatAbhaNumber(value: string | null | undefined): string | null {
  const digits = abhaDigits(value);
  if (!digits) return value ?? null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

/** For audit lines and logs: 91-****-****-9012. */
export function maskAbhaNumber(value: string): string {
  const digits = abhaDigits(value);
  return digits ? `${digits.slice(0, 2)}-****-****-${digits.slice(10)}` : "***";
}

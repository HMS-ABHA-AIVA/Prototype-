import type { Request } from "express";

type Extra = Record<string, string | number | boolean | null | undefined>;

// Strip line breaks and control characters so untrusted values (e-mail typed at login, etc.) can never
// forge or split a log line, and keep entries short.
const clean = (value: Extra[string]) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : value;

/**
 * Master routine for security-relevant events (NDHM secure-development guideline 2.1.7 / 3.1.3):
 * one JSON object per line on stdout, so the hosting platform's log pipeline can collect it.
 * It records who (user/facility id), from where (IP), what (event, method, path) and when (ts).
 * It never records request bodies, passwords, OTPs, tokens, Aadhaar or other personal data.
 */
export const logSecurityEvent = (event: string, req?: Request, extra: Extra = {}) => {
  // ABDM routes carry the login as req.user, hospital routes (/api/v1) as req.staff
  const staff = (req as { staff?: { userId?: string; facilityId?: string } } | undefined)?.staff;
  const user = (req as { user?: { id?: string; facilityId?: string } } | undefined)?.user ?? (staff ? { id: staff.userId, facilityId: staff.facilityId } : undefined);
  const facility = (req as { facility?: { id?: string } } | undefined)?.facility;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    type: "security",
    event,
    ip: req?.ip,
    userId: user?.id,
    facilityId: user?.facilityId ?? facility?.id,
    method: req?.method,
    path: req?.originalUrl?.split("?")[0],
  };

  for (const [key, value] of Object.entries(extra)) entry[key] = clean(value);

  console.log(JSON.stringify(entry));
};

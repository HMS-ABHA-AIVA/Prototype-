import type { Request } from "express";

/** Who is performing this request, for the audit trail: the signed-in staff member (see hospital/auth/session.ts). */
export function actorOf(req: Request): string {
  return req.staff?.name ?? "system";
}

/** The signed-in staff member. Only call this behind requireStaff (every /api/v1 route but sign-in and the platform). */
export function staffOf(req: Request) {
  if (!req.staff) throw new Error("staffOf() used on a route that is not behind requireStaff");
  return req.staff;
}

/** Strips everything but digits: '91-1234-5678-9012' -> '91123456789012'. */
export const digitsOnly = (value: string) => value.replace(/\D/g, "");

import type { Response, NextFunction } from "express";
import { prisma } from "../../config/db.js";
import type { userAuthRequest } from "./verifyUserJwt.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

// Records who did what in the ABHA module, and whether it worked (NHA audit trail).
// Place it after verifyUserJwt. It logs metadata only: ids, action, outcome, status code, error code, IP and
// user agent. Never request/response bodies, so Aadhaar, mobile numbers, OTPs and tokens cannot leak into it.
export const auditAbha = (action: string) => (req: userAuthRequest, res: Response, next: NextFunction) => {
  res.on("finish", () => {
    if (!req.user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const errorCode = typeof res.locals.errorCode === "string" ? res.locals.errorCode : null;

    prisma.abhaAuditLog
      .create({
        data: {
          facilityId: req.user.facilityId,
          userId: req.user.id,
          patientId: asUuid(body.patientId) ?? asUuid(query.patientId),
          transactionId: asUuid(body.transactionId) ?? asUuid(query.transactionId),
          action,
          outcome: res.statusCode < 400 ? "SUCCESS" : "FAILURE",
          httpStatus: res.statusCode,
          errorCode,
          ip: req.ip ?? null,
          userAgent: req.get("user-agent")?.slice(0, 200) ?? null,
        },
      })
      .catch((error: unknown) => {
        // never fail the request because the audit write failed, but do not stay silent about it
        console.error("ABHA audit log write failed", error instanceof Error ? error.message : error);
      });
  });

  next();
};

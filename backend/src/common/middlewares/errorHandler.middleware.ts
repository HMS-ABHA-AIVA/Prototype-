import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { ApiError } from "../errors/appError.js";
import { logSecurityEvent } from "../utils/securityLog.js";

// Maps the failures NDHM asks to be logged (authentication, access control, validation, rate limits) to events.
const securityEventFor = (status: number, code?: string, message?: string) => {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  // Controllers report schema failures as 400 "Invalid request ..." (some without a code).
  if (code === "VALIDATION" || code === "UNSUPPORTED_MEDIA_TYPE" || (status === 400 && /^invalid (request|query)/i.test(message ?? ""))) {
    return "INPUT_REJECTED";
  }
  return undefined;
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof ApiError) {
    res.locals.errorCode = err.code; // read by the ABHA audit trail
    const event = securityEventFor(err.statusCode, err.code, err.message);
    if (event) logSecurityEvent(event, req, { status: err.statusCode, code: err.code });
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errors: err.errors,
      ...(err.code ? { code: err.code } : {}),
    });
  }

  if (err instanceof ZodError) {
    logSecurityEvent("INPUT_REJECTED", req, { status: 400, code: "VALIDATION" });
    return res.status(400).json({
      success: false,
      message: `Invalid request: ${err.issues.map((issue) => issue.message).join(", ")}`,
      errors: [],
    });
  }

  // body-parser failures (malformed JSON, payload too large ...) carry a 4xx status and a safe message.
  const httpErr = err as Error & { status?: number; statusCode?: number; type?: string };
  const clientStatus = httpErr.status ?? httpErr.statusCode;
  if (clientStatus && clientStatus >= 400 && clientStatus < 500) {
    logSecurityEvent("INPUT_REJECTED", req, { status: clientStatus, code: httpErr.type });
    return res.status(clientStatus).json({
      success: false,
      message: httpErr.type === "entity.parse.failed" ? "Invalid JSON in request body" : "Invalid request",
      errors: [],
    });
  }

  console.error(err);
  logSecurityEvent("SYSTEM_ERROR", req, { status: 500 });

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

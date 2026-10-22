/**
 * Every failure the hospital API (/api/v1) reports on purpose is an AppError. Its error middleware (hospital/index.ts)
 * turns it into   { "error": { "code": "NOT_FOUND", "message": "Patient not found" } }
 * Anything else that gets thrown is treated as a bug and returned as a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const unauthorized = (message = "Please sign in to continue") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Your role does not have access to this") => new AppError(403, "FORBIDDEN", message);
export const conflict = (message: string) => new AppError(409, "CONFLICT", message);
export const unavailable = (message: string, details?: unknown) => new AppError(503, "SERVICE_UNAVAILABLE", message, details);

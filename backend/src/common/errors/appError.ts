export class ApiError extends Error {
  statusCode: number;
  success: false;
  errors: unknown[];
  // Stable machine-readable reason (e.g. "ABHA_NOT_FOUND") so the UI can show a specific message.
  code: string | undefined;

  constructor(
    statusCode: number,
    message: string,
    errors: unknown[] = [],
    code?: string,
  ) {
    super(message);

    this.statusCode = statusCode;
    this.success = false;
    this.errors = errors;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

//EXAMPLE USAGE
// throw new ApiError(400, "client error", [
// "fix 1",
// "fix 2",
// ]);
// throw new ApiError(404, "No ABHA found", [], "ABHA_NOT_FOUND");

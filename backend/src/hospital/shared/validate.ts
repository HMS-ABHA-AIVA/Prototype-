import type { Request } from "express";
import { z } from "zod";
import { AppError, badRequest } from "./errors.js";

/** Validates data against a zod schema; on failure throws a 400 listing every problem field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
  throw new AppError(400, "VALIDATION_ERROR", "The request is not valid", issues);
}

/** Reads :id (or another named route parameter) and requires it to be a UUID. */
export function uuidParam(req: Request, name = "id"): string {
  const value = req.params[name];
  if (typeof value !== "string" || !z.uuid().safeParse(value).success) throw badRequest(`'${name}' must be a valid id`);
  return value;
}

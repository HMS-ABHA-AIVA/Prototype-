import type { z } from "zod";
import { ApiError } from "../errors/appError.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a request body or query with a zod schema; failures become a 400 listing what is wrong. */
export const parseInput = <S extends z.ZodType>(schema: S, data: unknown, what = "body"): z.output<S> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(400, `Invalid request ${what}: ${result.error.issues.map((issue) => issue.message).join(", ")}`, [], "VALIDATION");
  }
  return result.data;
};

/** A route parameter that must be a UUID (our ids are uuids). */
export const uuidParam = (value: unknown, label = "ID"): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError(400, `Invalid request: ${label} must be a UUID`, [], "VALIDATION");
  }
  return value;
};

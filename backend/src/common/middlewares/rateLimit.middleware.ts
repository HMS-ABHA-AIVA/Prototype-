import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors/appError.js";

interface RateLimitOptions {
  windowMs: number;
  max: number;
  // Defaults to the client IP + route. Pass a function to key on something else (e.g. the login e-mail).
  key?: (req: Request) => string | undefined;
  message?: string;
}

// Minimal in-memory fixed-window limiter (OTP endpoints, logins, whole API).
// Single-instance only; swap for a shared store (e.g. Redis) if the API is scaled horizontally.
//
// Every response carries the limit, what is left and when the window resets (RateLimit-* headers); a 429 also
// carries Retry-After, so clients are told the limit and the reset time (NDHM API security guideline).
export const rateLimit = ({ windowMs, max, key: keyOf, message }: RateLimitOptions) => {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Automated test runs sign in hundreds of times from one address. They may switch limiting off; production never can.
  const disabled = process.env.RATE_LIMIT_ENABLED === "false" && process.env.NODE_ENV !== "production";

  return (req: Request, res: Response, next: NextFunction) => {
    if (disabled) return next();
    const now = Date.now();
    const key = keyOf ? keyOf(req) : `${req.ip}:${req.path}`;

    // Nothing to key on (e.g. login without an e-mail): let validation reject the request.
    if (!key) return next();

    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      hits.set(key, entry);
    } else {
      entry.count += 1;
    }

    const resetSeconds = Math.max(Math.ceil((entry.resetAt - now) / 1000), 1);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(max - entry.count, 0)));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    // Opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }

    if (entry.count > max) {
      res.setHeader("Retry-After", String(resetSeconds));
      return next(new ApiError(429, message ?? "Too many requests. Please wait a minute and try again.", [], "RATE_LIMITED"));
    }

    next();
  };
};

import type { Request, Response, NextFunction } from "express";
import { rateLimit } from "./rateLimit.middleware.js";

// API responses carry patient and ABHA data: tell browsers and proxies never to cache them
// (NDHM secure-development guideline: disable caching of sensitive information).
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
};

// Overall ceiling per client IP across the whole API. Generous (normal use is a few requests a minute), so it
// only stops automated abuse; logins and OTP routes have their own, much stricter limits.
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
  key: (req) => `api-ip:${req.ip}`,
  message: "Too many requests from this device. Please slow down and try again shortly.",
});

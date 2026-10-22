import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../errors/appError.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The hospital routes that take a file as the request body (an attached document, a radiology image). They accept the
// file's own content type; none of these is one a cross-site <form> can send, so the same preflight protection applies.
const UPLOAD_ROUTE = /^\/api\/v1\/(ipd\/[^/]+\/documents|lab\/orders\/[^/]+\/attachments)$/;
const UPLOAD_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "application/octet-stream"];

// CSRF defence for cookie-authenticated, state-changing routes. In production the auth cookies are
// SameSite=None, so a malicious page could otherwise make the browser submit a form to this API.
//  1. Every state-changing request must be application/json (or, on an upload route, a file type). A cross-site
//     <form> cannot send those content types, and a cross-site fetch() that does triggers a CORS preflight, which
//     only FRONTEND_URL is allowed to pass.
//  2. If the browser sends an Origin header, it must be our frontend or a local dev/Wi-Fi origin.
export const csrfGuard = (allowedOrigins: string | string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const allowed = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin");
  if (origin) {
    const isDev = process.env.NODE_ENV !== "production";
    const isLocalNetwork = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
    const isAllowed = allowed.includes(origin) || (isDev && isLocalNetwork);

    if (!isAllowed) {
      return next(new ApiError(403, "Request origin is not allowed", [], "CSRF_ORIGIN"));
    }
  }

  const isUpload = req.method === "POST" && UPLOAD_ROUTE.test(req.path) && typeof req.is(UPLOAD_TYPES) === "string";
  if (!req.is("application/json") && !isUpload) {
    return next(new ApiError(415, "Requests must be sent as application/json", [], "UNSUPPORTED_MEDIA_TYPE"));
  }

  next();
};

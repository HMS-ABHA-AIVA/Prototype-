import type { Request, Response } from "express";
import { ApiError } from "../errors/appError.js";

// JWT-style tokens only (base64url, dots). Anything else in a cookie is rejected before it can reach an outgoing header.
const SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]{10,4096}$/;
export const readSafeCookie = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;

const baseOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: (process.env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
});

// ABDM gateway tokens live 1200s (20 min). Expire the cookie a little early so the
// frontend sees "ABDM authentication required" and refreshes instead of hitting ABDM with a dead token.
const DEFAULT_TTL_SEC = 1200;
const SAFETY_MARGIN_SEC = 30;

const toMaxAgeMs = (expiresInSec: unknown, fallbackSec = DEFAULT_TTL_SEC, marginSec = 0) => {
  const sec = typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : fallbackSec;
  return Math.max(sec - marginSec, 10) * 1000;
};

export const setAbdmSessionCookies = (
  res: Response,
  tokens: { abdmAccessToken: string; abdmRefreshToken: string; expiresIn?: unknown; refreshExpiresIn?: unknown },
) => {
  res.cookie("abdmAccessToken", tokens.abdmAccessToken, {
    ...baseOptions(),
    maxAge: toMaxAgeMs(tokens.expiresIn, DEFAULT_TTL_SEC, SAFETY_MARGIN_SEC),
  });
  res.cookie("abdmRefreshToken", tokens.abdmRefreshToken, {
    ...baseOptions(),
    maxAge: toMaxAgeMs(tokens.refreshExpiresIn, 1800),
  });
};

// The ABHA X-token is bound to one patient with a *signed* cookie so a record page can never
// show another patient's ABHA profile/QR. Signing uses cookie-parser's secret (see app.ts).
export type AbhaTokenKind = "abha" | "phr";

export const setAbhaSessionCookies = (res: Response, xToken: string, patientId: string, expiresIn?: unknown, kind: AbhaTokenKind = "abha") => {
  const maxAge = toMaxAgeMs(expiresIn, 1800);
  res.cookie("abhaXToken", xToken, { ...baseOptions(), maxAge });
  // An ABHA-address login yields a PHR token, which only works on the PHR profile/card calls.
  res.cookie("abhaXKind", kind, { ...baseOptions(), maxAge, signed: true });
  res.cookie("abhaXPatientId", patientId, { ...baseOptions(), maxAge, signed: true });
};

// Short-lived T-token between mobile "verify OTP" and "verify user".
export const setTTokenCookie = (res: Response, tToken: string, expiresIn?: unknown) => {
  res.cookie("t_token", tToken, { ...baseOptions(), maxAge: toMaxAgeMs(expiresIn, 600) });
};

export const getAbhaSessionToken = (req: Request, patientId: string): string => {
  const xToken = readSafeCookie(req.cookies?.abhaXToken);
  const boundPatientId = req.signedCookies?.abhaXPatientId;
  if (!xToken || !boundPatientId || boundPatientId !== patientId) {
    throw new ApiError(401, "ABHA verification session expired", [], "ABHA_SESSION_EXPIRED");
  }
  return xToken;
};

export const getAbhaSessionKind = (req: Request): AbhaTokenKind => (req.signedCookies?.abhaXKind === "phr" ? "phr" : "abha");

const ABDM_COOKIES = ["abdmAccessToken", "abdmRefreshToken", "abhaXToken", "abhaXPatientId", "abhaXKind", "t_token"];

/** Drop every ABDM-related cookie (on login/logout) so one user's ABDM session never leaks to the next. */
export const clearAbdmCookies = (res: Response) => {
  for (const name of ABDM_COOKIES) res.clearCookie(name, baseOptions());
};

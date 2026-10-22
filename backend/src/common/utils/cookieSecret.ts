import { createHmac } from "crypto";

// The cookie-signing key is derived from, but is not the same as, the JWT secret, so one key is never used
// for two purposes (NDHM secure-development guideline on cryptographic practices).
export const getCookieSecret = (): string => {
  const base = process.env.USER_ACCESS_TOKEN_SECRET;
  if (!base) throw new Error("USER_ACCESS_TOKEN_SECRET is not configured");
  return createHmac("sha256", base).update("abha-cookie-signing-v1").digest("hex");
};

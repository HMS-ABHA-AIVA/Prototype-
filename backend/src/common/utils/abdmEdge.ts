import type { AxiosResponse } from "axios";
import { ApiError } from "../errors/appError.js";

// ABDM sits behind a CDN firewall (CloudFront). It answers a server hosted outside India with HTTP 403 and an HTML "Request
// blocked" page instead of ABDM's own JSON, even with correct credentials. That is a hosting-location problem, not a
// credentials problem, so it must not be reported as "wrong client ID / secret".

/** True when a 403 looks like the CDN's block page rather than an ABDM answer. */
export const isEdgeBlock = (response: AxiosResponse | undefined): boolean => {
  if (!response || response.status !== 403) return false;
  const body = typeof response.data === "string" ? response.data : Buffer.isBuffer(response.data) ? response.data.toString("utf8", 0, 400) : "";
  const headers = response.headers ?? {};
  return (
    /cloudfront|request blocked|could not be satisfied/i.test(body) ||
    /cloudfront/i.test(String(headers["server"] ?? headers["via"] ?? headers["x-cache"] ?? "")) ||
    // ABDM's own errors are JSON; an HTML 403 is not from ABDM
    /^\s*</.test(body)
  );
};

/** Metadata only, to confirm the diagnosis from the host's logs. Never the request, tokens or credentials. */
export const edgeLogInfo = (response: AxiosResponse | undefined) => ({
  server: response?.headers?.["server"],
  via: response?.headers?.["via"],
  xCache: response?.headers?.["x-cache"],
  contentType: response?.headers?.["content-type"],
  htmlBody: typeof response?.data === "string" && /^\s*</.test(response.data),
  blockedByEdge: isEdgeBlock(response),
});

export const regionBlockedError = () =>
  new ApiError(
    502,
    "ABDM refused the connection from where this server is hosted (its sandbox blocks hosting outside India). The credentials are not the problem: host the backend in India (for example Mumbai) and try again.",
    [],
    "ABDM_REGION_BLOCKED",
  );

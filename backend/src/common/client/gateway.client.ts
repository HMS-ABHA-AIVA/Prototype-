import axios from "axios";
import { randomUUID } from "crypto";

type AbdmEnvironment = "SANDBOX" | "PRODUCTION";

// The HIE-CM gateway (calls the HIP makes to ABDM, outside the ABHA enrolment APIs).
export const getGatewayBaseUrl = (environment: AbdmEnvironment) =>
  environment === "SANDBOX"
    ? process.env.SANDBOX_GATEWAY_URL || "https://dev.abdm.gov.in/api/hiecm"
    : process.env.PROD_GATEWAY_URL || "https://live.abdm.gov.in/api/hiecm";

const gatewayHttp = axios.create({ timeout: 15_000 });

const headers = (token: string, environment: AbdmEnvironment, hipId?: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "REQUEST-ID": randomUUID(),
  TIMESTAMP: new Date().toISOString(),
  "X-CM-ID": environment === "SANDBOX" ? "sbx" : "abdm",
  ...(hipId ? { "X-HIP-ID": hipId } : {}),
});

// Never log request bodies or tokens: a share body is a person's profile.
export class GatewayError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
  }
}

const wrap = (action: string, error: unknown): never => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: { code?: string; message?: string } } | undefined;
    const detail = data?.error ? `${data.error.code ?? ""} ${data.error.message ?? ""}`.trim() : error.code;
    throw new GatewayError(error.response?.status, `${action} failed${error.response?.status ? ` (HTTP ${error.response.status})` : ""}${detail ? `: ${detail}` : ""}`);
  }
  throw error;
};

/** The keys ABDM signs its callbacks with (JWKS). The endpoint needs the gateway session token. */
export const fetchGatewayCerts = async (token: string, environment: AbdmEnvironment) => {
  try {
    const response = await gatewayHttp.get(`${getGatewayBaseUrl(environment)}/gateway/v3/certs`, { headers: headers(token, environment) });
    const body = response.data as { keys?: Record<string, unknown>[] } | Record<string, unknown>[];
    return (Array.isArray(body) ? body : body.keys ?? []) as Record<string, unknown>[];
  } catch (error) {
    return wrap("Fetching the ABDM gateway keys", error);
  }
};

/** Reply to a received profile share: a token on success, or an error the patient's app can show. */
export const sendPatientShareReply = async (
  token: string,
  environment: AbdmEnvironment,
  hipId: string,
  shareRequestId: string,
  outcome:
    | { ok: true; abhaAddress: string; counterCode: string; tokenNumber: number; expirySeconds: number }
    | { ok: false; code: string; message: string },
) => {
  const body = outcome.ok
    ? {
        acknowledgement: {
          status: "SUCCESS",
          abhaAddress: outcome.abhaAddress,
          profile: { context: outcome.counterCode, tokenNumber: String(outcome.tokenNumber), expiry: String(outcome.expirySeconds) },
        },
        response: { requestId: shareRequestId },
      }
    : { error: { code: outcome.code, message: outcome.message }, response: { requestId: shareRequestId } };

  try {
    await gatewayHttp.post(`${getGatewayBaseUrl(environment)}/patient-share/v3/on-share`, body, { headers: headers(token, environment, hipId) });
  } catch (error) {
    wrap("Sending the share reply", error);
  }
};

/** Register where ABDM should deliver callbacks for this client id (last writer wins per client id). */
export const updateBridgeUrl = async (token: string, environment: AbdmEnvironment, url: string) => {
  try {
    const response = await gatewayHttp.patch(`${getGatewayBaseUrl(environment)}/gateway/v3/bridge/url`, { url }, { headers: headers(token, environment) });
    return response.status;
  } catch (error) {
    return wrap("Registering the bridge URL", error);
  }
};

/** What ABDM holds for the HIP id (isHip / active ...). The registered URL cannot be read back. */
export const getBridgeService = async (token: string, environment: AbdmEnvironment, hipId: string) => {
  try {
    const response = await gatewayHttp.get(`${getGatewayBaseUrl(environment)}/gateway/v3/bridge-service/serviceId/${encodeURIComponent(hipId)}`, {
      headers: headers(token, environment),
    });
    return response.data as Record<string, unknown>;
  } catch (error) {
    return wrap("Reading the bridge service", error);
  }
};

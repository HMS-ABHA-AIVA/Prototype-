import axios from "axios";
import { randomUUID } from "crypto";
import { ApiError } from "../errors/appError.js";
import { edgeLogInfo, isEdgeBlock, regionBlockedError } from "../utils/abdmEdge.js";

type AbdmEnvironment = "SANDBOX" | "PRODUCTION";

interface GenerateSessionTokenParams {
  clientId: string;
  clientSecret: string;
  environment: AbdmEnvironment;
}

export const generateAbdmSessionToken = async ({
  clientId,
  clientSecret,
  environment,
}: GenerateSessionTokenParams) => {
  // V3 gateway session endpoints (the legacy /gateway/v0.5/sessions ones are not accepted for M1).
  const Url = environment === "SANDBOX"
    ? process.env.SANDBOX_SESSION_URL || "https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions"
    : process.env.PROD_SESSION_URL || "https://live.abdm.gov.in/api/hiecm/gateway/v3/sessions";

  const cmId = environment === "SANDBOX" ? "sbx" : "abdm";

  const requestId = randomUUID();
  try {
    const response = await axios.post(
      `${Url}`,
      { clientId, clientSecret, grantType: "client_credentials" },
      {
        timeout: 15_000,
        headers: {
          "Content-Type": "application/json",
          "REQUEST-ID": requestId,
          "TIMESTAMP": new Date().toISOString(),
          "X-CM-ID": cmId,
        },
      }
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("ABDM session request failed", {
        requestId,
        status: error.response?.status,
        code: error.code,
        timedOut: error.code === "ECONNABORTED",
        ...(error.response?.status === 403 ? edgeLogInfo(error.response) : {}),
      });
      if (isEdgeBlock(error.response)) throw regionBlockedError();
      if (!error.response || error.response.status >= 500 || error.code === "ECONNABORTED") {
        throw new ApiError(503, "ABHA service is temporarily unavailable. Please try again.");
      }
      if (error.response.status === 401 || error.response.status === 403) {
        throw new ApiError(502, "ABDM rejected authentication. Check the configured credentials and environment.", [], "ABDM_AUTH_REJECTED");
      }
      const data = error.response.data as { error?: { code?: string; message?: string }; message?: string } | undefined;
      const gatewayMessage = data?.error?.message || (typeof data?.message === "string" ? data.message : undefined);
      throw new ApiError(502, gatewayMessage || "ABDM could not issue a session token. Check the credentials and try again.");
    }
    throw error;
  }
};

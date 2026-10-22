import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../../config/db.js";
import { ApiError } from "../../../common/errors/appError.js";
import type { userAuthRequest } from "../../../common/middlewares/verifyUserJwt.js";
import { logSecurityEvent } from "../../../common/utils/securityLog.js";
import { inboundShareSchema, registerShareSchema, shareConfigQuerySchema, shareIdParamSchema } from "../../../common/validators/share.validator.js";
import { dismissShareService, getShareConfigService, listSharesService, processInboundShare, purgeExpiredShares, registerShareService, verifyCallbackToken } from "./share.service.js";

// ---------------------------------------------------------------------------
// ABDM -> us: POST /api/v3/hip/patient/share. Public (ABDM is not a logged-in user), so it is gated by the
// callback checks below instead. It fails closed and does nothing with the body until they pass.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reject = (req: Request, status: number, reason: string, code: string) => {
  logSecurityEvent("ABDM_CALLBACK_REJECTED", req, { reason });
  return new ApiError(status, "Callback rejected", [], code);
};

export const receivePatientShareController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. a bearer token is present
    const header = req.get("authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) throw reject(req, 401, "no_bearer_token", "CALLBACK_UNAUTHORIZED");

    // 2. it is for a facility we serve (X-HIP-ID is the facility's HFR id)
    const hipId = req.get("x-hip-id")?.trim();
    const facility = hipId ? await prisma.facility.findUnique({ where: { hfrId: hipId }, select: { id: true } }) : null;
    if (!hipId || !facility) throw reject(req, 403, "unknown_hip_id", "CALLBACK_FORBIDDEN");

    // 3. the token is a valid ABDM-signed JWT
    const verified = await verifyCallbackToken(token, facility.id);
    if (!verified) throw reject(req, 401, "token_not_verified", "CALLBACK_UNAUTHORIZED");

    const requestId = req.get("request-id")?.trim();
    const body = inboundShareSchema.safeParse(req.body);
    if (!requestId || !UUID.test(requestId) || !body.success || body.data.metaData.hipId !== hipId) {
      throw reject(req, 400, "invalid_body", "VALIDATION");
    }

    // Answer ABDM at once; registering and replying with the token happen afterwards (30 second limit).
    res.status(200).json({ status: "received" });
    void processInboundShare(req, facility.id, hipId, requestId, body.data, verified.environment);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// staff: the queue of shared profiles
// ---------------------------------------------------------------------------

const parseShareId = (value: unknown) => {
  const parsed = shareIdParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "Invalid request: share ID must be a UUID", [], "VALIDATION");
  return parsed.data;
};

export const listSharesController = async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    // piggy-back the cleanup on the staff polling so it also happens without a scheduler
    void purgeExpiredShares().catch(() => undefined);
    const data = await listSharesService(req.user!.facilityId);
    res.status(200).json({ success: true, message: "Shared profiles retrieved", data });
  } catch (error) {
    next(error);
  }
};

export const shareConfigController = async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    const query = shareConfigQuerySchema.safeParse(req.query);
    if (!query.success) throw new ApiError(400, `Invalid query parameters: ${query.error.issues.map((i) => i.message).join(", ")}`, [], "VALIDATION");
    const data = await getShareConfigService(req.user!.facilityId, query.data.environment);
    res.status(200).json({ success: true, message: "Counter QR settings retrieved", data });
  } catch (error) {
    next(error);
  }
};

export const registerShareController = async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    const shareId = parseShareId(req.params.shareId);
    const body = registerShareSchema.safeParse(req.body);
    if (!body.success) throw new ApiError(400, `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`, [], "VALIDATION");

    const data = await registerShareService(shareId, req.user!.facilityId, body.data.phone);
    logSecurityEvent("PATIENT_SHARE_REGISTERED", req, { patientId: data.patientId, created: data.created });
    res.status(data.created ? 201 : 200).json({
      success: true,
      message: data.created ? "Patient registered from the shared profile" : "This ABHA is already linked to a patient here",
      data,
    });
  } catch (error) {
    next(error);
  }
};

export const dismissShareController = async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    await dismissShareService(parseShareId(req.params.shareId), req.user!.facilityId);
    res.status(200).json({ success: true, message: "Shared profile dismissed" });
  } catch (error) {
    next(error);
  }
};

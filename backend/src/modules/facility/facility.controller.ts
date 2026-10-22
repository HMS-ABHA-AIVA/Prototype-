import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../../common/errors/appError.js";
import { registerFacilitySchema, loginFacilitySchema, addAbdmDetailsSchema ,createAdminSchema } from "../../common/validators/facility.validators.js";
import { registerFacilityService, loginFacilityService, logoutFacilityService, addAbdmDetailsService ,createAdminService} from "./facility.service.js";
import bcrypt from "bcrypt";
import { logSecurityEvent } from "../../common/utils/securityLog.js";
import type { authRequest } from "../../common/middlewares/verifyFacilityJwt.js";



export const registerFacility = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = registerFacilitySchema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues.map((issue: any) => issue.message).join(", ")
      throw new ApiError(400, `invalid request body: ${message}`);
    }

    const hashedPassword = await bcrypt.hash(result.data.password, 10);

    const facility = await registerFacilityService(result.data, hashedPassword);

    if (!facility) {
      throw new ApiError(400, "facility registration failed");
    }

    logSecurityEvent("FACILITY_REGISTERED", req, { facilityId: facility.id, hfrId: facility.hfrId });

    res.status(201).json({
      success: true,
      message: "facility registered successfully",
      data: {
        name: facility.name,
        email: facility.email,
        hfrId: facility.hfrId,
        createdAt: facility.createdAt,
        updatedAt: facility.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};


export const loginFacility = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = loginFacilitySchema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues
        .map((issue: any) => issue.message)
        .join(", ");

      throw new ApiError(400, `Invalid request body: ${message}`);
    }

    const { email, password } = result.data;

    const { facility, tokens } = await loginFacilityService(email, password);

    logSecurityEvent("LOGIN_SUCCESS", req, { actor: "facility", email: facility.email });

    res.cookie("accessToken", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 2 * 60 * 60 * 1000,
    });

    res.cookie("refreshToken", tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        name: facility.name,
        email: facility.email,
        hfrId: facility.hfrId,
      }
    });

  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      const attempted = (req.body as { email?: unknown } | undefined)?.email;
      logSecurityEvent("LOGIN_FAILURE", req, { actor: "facility", email: typeof attempted === "string" ? attempted : undefined });
    }
    next(error);
  }
}

export const logoutFacility = async (req: authRequest, res: Response,next:NextFunction) => {
  try {
    const facilityId = req.facility!.id;

    if (!facilityId) {
      throw new ApiError(400, "Facility ID not found");
    }

    const logoutcount = await logoutFacilityService(facilityId);
    logSecurityEvent("LOGOUT", req, { actor: "facility" });

    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
      loggedOutSessions: logoutcount.count,
    });
  } catch (error) {
    next(error);
  }
};


export const addAbdmDetails = async (req: authRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.facility) {
      throw new ApiError(401, "Facility authentication required");
    }

    const result = addAbdmDetailsSchema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join(", ");

      throw new ApiError(400, `Invalid request body: ${message}`);
    }

    const { clientId, clientSecret, environment } = result.data;

    const abdmData = await addAbdmDetailsService(
      req.facility.id,
      clientId,
      clientSecret,
      environment
    );

    // Security-configuration change (privileged action): record who, never the secret.
    logSecurityEvent("ABDM_CREDENTIALS_SAVED", req, { environment });

    res.status(200).json({
      success: true,
      message: "ABDM credentials configured successfully",
      data: {
        facilityId: abdmData.facilityId,
        clientId: abdmData.clientId,
        createdAt: abdmData.createdAt,
        updatedAt: abdmData.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createAdmin = async (req: authRequest, res: Response, next: NextFunction) => {
  try{
     if (!req.facility) {
      throw new ApiError(401, "Facility authentication required");
    }

    const result = createAdminSchema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .join(", ");
      throw new ApiError(400, `Invalid request body: ${message}`);
    }

    const user = await createAdminService(req.facility.id, result.data);

    logSecurityEvent("STAFF_ACCOUNT_CREATED", req, { staffUserId: user.id });

    res.status(201).json({
      success: true,
      message: "Admin created successfully",
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        facilityId: user.facilityId,
      }
    });

  }catch(error){
    next(error);
  }
}

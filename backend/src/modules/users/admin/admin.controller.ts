import type { Request, Response, NextFunction } from "express";
import type { userAuthRequest } from "../../../common/middlewares/verifyUserJwt.js"
import { loginAdminSchema } from "../../../common/validators/admin.validator.js"
import { ApiError } from "../../../common/errors/appError.js";
import { loginAdminService ,logoutAdminService } from "./admin.service.js";
import { clearAbdmCookies, readSafeCookie } from "../../../common/utils/abdmCookies.js";
import { endAbhaSessionService } from "../../../integration/Abha/m1/m1.service.js";
import { logSecurityEvent } from "../../../common/utils/securityLog.js";


export const adminLogin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = loginAdminSchema.safeParse(req.body);
        if (!result.success) {
            const message = result.error.issues.map((issue: any) => issue.message).join(", ")
            throw new ApiError(400, `invalid request body: ${message}`);
        }

        const loggedInAdmin = await loginAdminService(result.data.email, result.data.password);
        if (!loggedInAdmin) {
            throw new ApiError(401, "Invalid email or password");
        }

        // A new login must never inherit the previous user's ABDM session (it may belong to another facility).
        clearAbdmCookies(res);
        logSecurityEvent("LOGIN_SUCCESS", req, { actor: "staff", userId: loggedInAdmin.user.id, email: loggedInAdmin.user.email });

        res.cookie("accessToken", loggedInAdmin.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
            maxAge: 2 * 60 * 60 * 1000,
        });

        res.cookie("refreshToken", loggedInAdmin.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        res.status(200).json({
            success: true,
            message: "Admin logged in successfully",
            data: {
                id: loggedInAdmin.user.id,
                email: loggedInAdmin.user.email,
                name: loggedInAdmin.user.name,
                facilityName: loggedInAdmin.user.facilityName,
                // what the hospital screens need: the person's role, and whether a new password is due first
                role: loggedInAdmin.user.role,
                staffId: loggedInAdmin.user.staffId,
                department: loggedInAdmin.user.department,
                mustChangePassword: loggedInAdmin.user.mustChangePassword,
            }
        });
    } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) {
            const attempted = (req.body as { email?: unknown } | undefined)?.email;
            logSecurityEvent("LOGIN_FAILURE", req, { actor: "staff", email: typeof attempted === "string" ? attempted : undefined });
        }
        next(error)
    }
}


export const adminLogout = async (req: userAuthRequest,res: Response,next: NextFunction) => {

    try {
        if(!req.user){
            throw new ApiError(401,"unauthorized");
        }
        await logoutAdminService(req.user.id);

        // End the patient's ABHA session at ABDM too (best effort; never blocks the sign-out).
        const abdmAccessToken = readSafeCookie(req.cookies?.abdmAccessToken);
        const xToken = readSafeCookie(req.cookies?.abhaXToken);
        // (A PHR token from an ABHA-address verification has no profile session to end.)
        if (abdmAccessToken && xToken && req.signedCookies?.abhaXKind !== "phr") {
            const requested = (req.body as { environment?: unknown } | undefined)?.environment;
            endAbhaSessionService(abdmAccessToken, xToken, requested === "PRODUCTION" ? "PRODUCTION" : "SANDBOX");
        }

        clearAbdmCookies(res);
        logSecurityEvent("LOGOUT", req, { actor: "staff" });

        res.clearCookie("accessToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        });

        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        });

        return res.status(200).json({
            success: true,
            message: "Admin logged out successfully"
        });

    } catch (error) {
        next(error);
    }
};

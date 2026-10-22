import type { Request,Response,NextFunction } from "express"
import jwt from "jsonwebtoken"
import {ApiError} from "../errors/appError.js"
import { logSecurityEvent } from "../utils/securityLog.js"
import { prisma } from "../../config/db.js"

export interface userAuthRequest extends Request {
     user?:{
        id : string
        email : string
        facilityId : string
        role? : string
    }
}

// Patient registration, the patient register and the ABHA (ABDM M1) screens are front-desk and clinical work. Roles that never
// handle registration (pharmacy, housekeeping, lab) reach patients only through the hospital modules, which limit what they see.
const NO_REGISTRATION_ACCESS = new Set(["pharmacist", "housekeeping", "lab"]);
const OPEN_TO_EVERY_ROLE = /^\/api\/(user\/admin\/logout|dashboard)(\/|$)/;

export const verifyUserJwt = async(req : userAuthRequest , _res : Response,next : NextFunction) =>{
    try {
        const token = req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ","")
        if(!token){
            logSecurityEvent("AUTH_TOKEN_MISSING", req);
            throw new ApiError(401,"unauthorized access");
        }


        let decoded;
        try {
            // Only the algorithm we sign with is accepted (rules out "alg: none" and algorithm-swap tokens).
            decoded = jwt.verify(token,process.env.USER_ACCESS_TOKEN_SECRET!,{ algorithms: ["HS256"] }) as {id : string , email : string, facilityId : string, tv?: number};
        } catch (error) {
            logSecurityEvent("AUTH_TOKEN_INVALID", req, { reason: error instanceof jwt.TokenExpiredError ? "expired" : "invalid" });
            throw new ApiError(401 , "unauthorized access");
        }

        // Looked up on every request, so that deactivating someone, removing their login, changing their password or switching
        // their hospital off takes effect at once rather than when the token expires.
        const account = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { active: true, tokenVersion: true, facilityId: true, mustChangePassword: true, role: true, facility: { select: { status: true } }, staff: { select: { active: true, role: true } } },
        });
        if (!account || !account.active || account.staff?.active === false || account.facilityId !== decoded.facilityId || account.tokenVersion !== (decoded.tv ?? 0)) {
            logSecurityEvent("AUTH_TOKEN_INVALID", req, { reason: "session-ended" });
            throw new ApiError(401, "unauthorized access");
        }
        if (account.facility.status !== "active") {
            throw new ApiError(403, "Access for this hospital is switched off. Please contact the people who run this system.", [], "HOSPITAL_SUSPENDED");
        }
        const openPath = OPEN_TO_EVERY_ROLE.test(req.originalUrl);
        // A new or reset password must be changed (POST /api/v1/auth/change-password) before anything else.
        if (account.mustChangePassword && !openPath) {
            throw new ApiError(403, "Please choose a new password before continuing.", [], "PASSWORD_CHANGE_REQUIRED");
        }
        const role = account.staff?.role ?? account.role;
        if (NO_REGISTRATION_ACCESS.has(role) && !openPath) {
            throw new ApiError(403, "Your role does not have access to this", [], "FORBIDDEN");
        }

        req.user = {
            id : decoded.id,
            email : decoded.email,
            facilityId : decoded.facilityId,
            role,
        }
        next();
    } catch (error) {
        next(error);
    }
}

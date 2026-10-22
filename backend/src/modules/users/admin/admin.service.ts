import bcrypt from "bcrypt";
import { prisma } from "../../../config/db.js";
import {ApiError} from "../../../common/errors/appError.js"
import jwt from "jsonwebtoken"
import { randomBytes } from "crypto"
import { LOCK_MINUTES, MAX_FAILED_LOGINS } from "../../../hospital/auth/accounts.js";

// Compared against when the account does not exist, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 12);

/** The login for an e-mail: exactly as typed first, then ignoring case (logins created from the staff screens are stored lower-case). */
const findLogin = async (email: string) =>
    (await prisma.user.findUnique({ where: { email }, include: { staff: true, facility: { select: { name: true, status: true } } } })) ??
    (await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, include: { staff: true, facility: { select: { name: true, status: true } } } }));

export const loginAdminService = async (email: string,password: string) => {
    const existingUser = await findLogin(email);

    if (!existingUser) {
        await bcrypt.compare(password, DUMMY_HASH);
        throw new ApiError(401, "invalid email or password");
    }

    // Five wrong passwords lock the login for a while (it is refused even with the right password until then).
    if (existingUser.lockedUntil && existingUser.lockedUntil > new Date()) {
        throw new ApiError(429, `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes or ask an administrator.`, [], "ACCOUNT_LOCKED");
    }

    const isPasswordValid = await bcrypt.compare(password,existingUser.passwordHash);

    if (!isPasswordValid) {
        const failed = existingUser.failedLogins + 1;
        const locks = failed >= MAX_FAILED_LOGINS;
        await prisma.user.update({
            where: { id: existingUser.id },
            data: { failedLogins: locks ? 0 : failed, ...(locks ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}) },
        });
        if (locks) {
            await prisma.auditLog.create({ data: { facilityId: existingUser.facilityId, actor: existingUser.email, action: "Account Locked", detail: `${MAX_FAILED_LOGINS} wrong passwords` } });
        }
        throw new ApiError(401, "invalid email or password");
    }

    // A deactivated login (or a deactivated staff member) is refused with the same message as a wrong password.
    if (!existingUser.active || existingUser.staff?.active === false) {
        throw new ApiError(401, "invalid email or password");
    }
    if (existingUser.facility.status !== "active") {
        throw new ApiError(403, "Access for this hospital is switched off. Please contact the people who run this system.", [], "HOSPITAL_SUSPENDED");
    }

    const claims = {
        id: existingUser.id,
        email: existingUser.email,
        facilityId: existingUser.facilityId,
        // Raised on a password change or when access is removed, which ends every session this login holds.
        tv: existingUser.tokenVersion,
    };

    const accessToken = jwt.sign(claims, process.env.USER_ACCESS_TOKEN_SECRET!, { expiresIn: "2h" });

    const refreshToken = jwt.sign(claims, process.env.USER_REFRESH_TOKEN_SECRET!, { expiresIn: "7d" });

    const tokenHash = await bcrypt.hash(refreshToken, 12);

   const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.userRefreshToken.create({
        data: {
            tokenHash,
            userId: existingUser.id,
            expiresAt,
        },
    });

    await prisma.user.update({ where: { id: existingUser.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await prisma.auditLog.create({ data: { facilityId: existingUser.facilityId, actor: existingUser.staff?.name ?? existingUser.name, action: "Signed In", detail: existingUser.staff?.role ?? existingUser.role } });

    return {
        accessToken,
        refreshToken,

        user: {
            id: existingUser.id,
            name: existingUser.staff?.name ?? existingUser.name,
            email: existingUser.email,
            facilityId: existingUser.facilityId,
            facilityName: existingUser.facility.name ?? null,
            role: existingUser.staff?.role ?? existingUser.role,
            staffId: existingUser.staff?.id ?? null,
            department: existingUser.staff?.department ?? null,
            mustChangePassword: existingUser.mustChangePassword,
        },
    };
};



export const logoutAdminService = async (userId : string) => {

     await prisma.userRefreshToken.deleteMany({
        where: {
            userId,
            expiresAt: {
                gt: new Date()
            }
        }
    });
};

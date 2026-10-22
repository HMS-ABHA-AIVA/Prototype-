import { prisma } from "../../config/db.js"
import { ApiError } from "../../common/errors/appError.js"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { randomBytes } from "crypto"
import { z } from 'zod'
import { createAdminSchema, registerFacilitySchema } from "../../common/validators/facility.validators.js"
import { generateAbdmSessionToken } from "../../common/client/facility.client.js"
import { encrypt } from "../../common/utils/encryption.js"

// Compared against when the account does not exist, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 10);

export const registerFacilityService = async (data: z.infer<typeof registerFacilitySchema>, hashedPassword: string) => {
    return prisma.facility.create({
        data: {
            name: data.name,
            email: data.email,
            hfrId: data.hfrId,
            passwordHash: hashedPassword,
        },
    });
}

export const loginFacilityService = async (email: string, password: string) => {
    const facility = await prisma.facility.findUnique({
        where: {
            email,
        },
    });

    if (!facility) {
        await bcrypt.compare(password, DUMMY_HASH);
        throw new ApiError(401, "Invalid email or password");
    }

    const isPasswordValid = await bcrypt.compare(
        password,
        facility.passwordHash
    );

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid email or password");
    }

    if (facility.status !== "active") {
        throw new ApiError(403, "Access for this hospital is switched off. Please contact the people who run this system.", [], "HOSPITAL_SUSPENDED");
    }

    const accesstoken = jwt.sign(
        {
            facilityId: facility.id,
            hfrId: facility.hfrId,
            email: facility.email
        },
        process.env.FACILITY_ACCESS_TOKEN_SECRET!,
        {
            expiresIn: "2h",
        }
    );

    const refreshtoken = jwt.sign(
        {
            facilityId: facility.id,
            hfrId: facility.hfrId,
            email: facility.email
        },
        process.env.FACILITY_REFRESH_TOKEN_SECRET!,
        {
            expiresIn: "1d",
        }
    );

    const refreshTokenHash = await bcrypt.hash(refreshtoken, 12);

    await prisma.facilityRefreshToken.create({
        data: {
            tokenHash: refreshTokenHash,
            facilityId: facility.id,
            expiresAt: new Date(
                Date.now() + 24 * 60 * 60 * 1000
            ),
        },
    });



    return {
        facility: {
            name: facility.name,
            email: facility.email,
            hfrId: facility.hfrId,
        },
        tokens: {
            accessToken: accesstoken,
            refreshToken: refreshtoken
        },
    };
}

export const logoutFacilityService = async (facilityId: string) => {
    return await prisma.facilityRefreshToken.deleteMany({
        where: {
            facilityId,
            // ideally identify THIS specific session here
        },
    });
}


export const addAbdmDetailsService = async (facilityId: string, clientId: string, clientSecret: string, environment: "SANDBOX" | "PRODUCTION") => {
    try {
        const abdmResponse = await generateAbdmSessionToken({ clientId, clientSecret, environment });

        if (!abdmResponse.accessToken || !abdmResponse.refreshToken) {
            throw new ApiError(400, "ABDM authentication failed");
        }
        const encryptedClientSecret = encrypt(clientSecret);
        
        return await prisma.facilityAbdmData.upsert({
            where: {
                facilityId_environment: {
                    facilityId,
                    environment,
                },
            },
            create: {
                facilityId,
                clientId,
                clientSecret : encryptedClientSecret,
                environment,
            },
            update: {
                clientId,
                clientSecret : encryptedClientSecret,
            },
        });
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : "Invalid ABDM credentials or environment";
        throw new ApiError(400, message);
    }
};

export const createAdminService = async (facilityId: string, data : z.infer<typeof createAdminSchema>) => {
    const existingAdmin = await prisma.user.findUnique({
        where: {
            email: data.email,
        },
    });

    if (existingAdmin) {
        throw new ApiError(400, "Admin with this email already exists");
    }

    const hashedPassword = await bcrypt.hash(data.password, 12);

    // The login and the person in the staff list are made together. The facility owner chose this password, so the staff
    // member is asked to choose their own at the first sign-in.
    return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                name: data.name,
                email: data.email,
                passwordHash: hashedPassword,
                facilityId: facilityId,
                mustChangePassword: true,
            },
        });
        await tx.staff.create({ data: { facilityId, userId: user.id, name: data.name, role: user.role, department: "Administration" } });
        await tx.auditLog.create({ data: { facilityId, actor: "facility owner", action: "Login Set", detail: `${data.name} (${data.email})` } });
        return user;
    });
}

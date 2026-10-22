import { createPublicKey } from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../../../config/db.js";
import { ApiError } from "../../../common/errors/appError.js";
import { decrypt } from "../../../common/utils/encryption.js";
import { generateAbdmSessionToken } from "../../../common/client/facility.client.js";
import { fetchGatewayCerts, sendPatientShareReply } from "../../../common/client/gateway.client.js";
import { logSecurityEvent } from "../../../common/utils/securityLog.js";
import { counterCodeSchema, type InboundShare } from "../../../common/validators/share.validator.js";
import { cleanText, formatAbhaNumber, normalizeGender } from "../m1/m1.service.js";

type Environment = "SANDBOX" | "PRODUCTION";

// How long the token handed to the patient (and therefore the shared profile) stays valid.
const SHARE_VALIDITY_SECONDS = 30 * 60;
// Unclaimed shares are kept a little past expiry before being deleted.
const PURGE_GRACE_MS = 10 * 60 * 1000;
// Stops one facility's queue being flooded by repeated shares.
const MAX_PENDING_PER_FACILITY = 300;

const GENERIC_FAILURE = "ABDM-9999";

// ---------------------------------------------------------------------------
// gateway session (cached; a share has to be answered within 30 seconds)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const getGatewayToken = async (facilityId: string, environment: Environment): Promise<string> => {
  const cacheKey = `${facilityId}:${environment}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const credentials = await prisma.facilityAbdmData.findUnique({
    where: { facilityId_environment: { facilityId, environment } },
  });
  if (!credentials) throw new Error(`No ABDM credentials saved for ${environment}`);

  const session = await generateAbdmSessionToken({
    clientId: credentials.clientId,
    clientSecret: decrypt(credentials.clientSecret),
    environment,
  });
  if (!session?.accessToken) throw new Error("ABDM did not issue a gateway token");

  const lifetimeMs = (typeof session.expiresIn === "number" ? session.expiresIn : 600) * 1000;
  tokenCache.set(cacheKey, { token: session.accessToken as string, expiresAt: Date.now() + lifetimeMs - 30_000 });
  return session.accessToken as string;
};

// ---------------------------------------------------------------------------
// callback authenticity: ABDM signs callbacks as RS256 JWTs, verifiable with the gateway's published keys
// ---------------------------------------------------------------------------

type Jwk = Record<string, unknown>;
const jwksCache = new Map<Environment, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_REFRESH_MS = 5 * 60 * 1000;

const keysFor = async (facilityId: string, environment: Environment, kid: string | undefined): Promise<Jwk[]> => {
  const cached = jwksCache.get(environment);
  const matches = (keys: Jwk[]) => keys.filter((key) => !kid || key.kid === kid);

  if (cached && matches(cached.keys).length > 0) return matches(cached.keys);
  // Unknown key id: refetch, but at most every few minutes so forged tokens cannot make us hammer ABDM.
  if (cached && Date.now() - cached.fetchedAt < JWKS_REFRESH_MS) return [];

  const keys = await fetchGatewayCerts(await getGatewayToken(facilityId, environment), environment);
  jwksCache.set(environment, { keys, fetchedAt: Date.now() });
  return matches(keys);
};

/**
 * Checks the callback's bearer token is a valid, unexpired ABDM-signed JWT. Returns the ABDM environment whose keys
 * verified it, or null. Fails closed: any problem fetching keys or verifying counts as "not verified".
 * Local development only: ABDM_SKIP_CALLBACK_JWT=true accepts any bearer token (ignored in production).
 */
export const verifyCallbackToken = async (token: string, facilityId: string): Promise<{ environment: Environment | undefined } | null> => {
  if (process.env.NODE_ENV !== "production" && process.env.ABDM_SKIP_CALLBACK_JWT === "true") {
    console.warn("ABDM_SKIP_CALLBACK_JWT is on: callback signatures are NOT being verified");
    return { environment: undefined };
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string" || decoded.header.alg !== "RS256") return null;
  const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;

  const configured = await prisma.facilityAbdmData.findMany({ where: { facilityId }, select: { environment: true } });
  for (const { environment } of configured) {
    try {
      for (const jwk of await keysFor(facilityId, environment, kid)) {
        try {
          jwt.verify(token, createPublicKey({ key: jwk as never, format: "jwk" }), { algorithms: ["RS256"] });
          return { environment };
        } catch {
          // wrong key for this token: try the next one
        }
      }
    } catch (error) {
      console.error("Could not load ABDM gateway keys", error instanceof Error ? error.message : error);
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// receiving a share
// ---------------------------------------------------------------------------

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

// Tokens restart every day (Indian time) and are sequential per counter.
const today = () => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00.000Z`);

const nextToken = async (facilityId: string, counterCode: string): Promise<number> => {
  const tokenDate = today();
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await prisma.shareTokenCounter.upsert({
        where: { facilityId_counterCode_tokenDate: { facilityId, counterCode, tokenDate } },
        create: { facilityId, counterCode, tokenDate, lastToken: 1 },
        update: { lastToken: { increment: 1 } },
      });
      return row.lastToken;
    } catch (error) {
      // two shares created the day's first counter row at the same moment: the retry increments it
      if (!isUniqueViolation(error) || attempt >= 3) throw error;
    }
  }
};

const abhaNumberOf = (value: string | null) => (value && value.replace(/\D/g, "").length === 14 ? formatAbhaNumber(value) : null);

const findLinkedPatient = async (facilityId: string, abhaNumber: string | null, abhaAddress: string) => {
  const match = await prisma.abhaPatient.findFirst({
    where: {
      patient: { facilityId },
      OR: [...(abhaNumber ? [{ abhaNumber }] : []), { abhaAddress: { equals: abhaAddress, mode: "insensitive" as const } }],
    },
    select: { patientId: true },
  });
  return match?.patientId ?? null;
};

const intOrNull = (value: string | null, min: number, max: number) => {
  const n = value === null ? NaN : Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * Processes a verified share after ABDM has been answered 200: store it for staff, hand back a token.
 * Everything here is best effort; failures are logged (without personal data) and, where possible, reported
 * to the patient's app as an error reply.
 */
export const processInboundShare = async (
  req: Parameters<typeof logSecurityEvent>[1],
  facilityId: string,
  hipId: string,
  requestId: string,
  body: InboundShare,
  verifiedEnvironment: Environment | undefined,
) => {
  const patient = body.profile.patient;
  const abhaAddress = patient.abhaAddress;
  const environment: Environment = verifiedEnvironment ?? (/@sbx$/i.test(abhaAddress) ? "SANDBOX" : "PRODUCTION");

  try {
    // an ABDM retry of a share we already handled
    if (await prisma.patientShare.findUnique({ where: { requestId }, select: { id: true } })) return;

    const token = await getGatewayToken(facilityId, environment);
    const reply = (outcome: Parameters<typeof sendPatientShareReply>[4]) => sendPatientShareReply(token, environment, hipId, requestId, outcome);

    const counter = counterCodeSchema.safeParse(body.metaData.context);
    const year = intOrNull(patient.yearOfBirth, 1900, new Date().getFullYear());
    if (!counter.success || year === null) {
      logSecurityEvent("PATIENT_SHARE_REJECTED", req, { facilityId, reason: !counter.success ? "counter" : "year_of_birth" });
      await reply({ ok: false, code: GENERIC_FAILURE, message: !counter.success ? "This counter code is not valid." : "The shared profile is missing a valid year of birth." });
      return;
    }
    const counterCode = counter.data;

    const now = new Date();
    // The same person scanning again while their token is valid gets the same token back.
    const existing = await prisma.patientShare.findFirst({
      where: { facilityId, counterCode, abhaAddress: { equals: abhaAddress, mode: "insensitive" }, expiresAt: { gt: now } },
    });
    if (existing) {
      await prisma.patientShare.update({ where: { id: existing.id }, data: { requestId } });
      await reply({
        ok: true,
        abhaAddress,
        counterCode,
        tokenNumber: existing.tokenNumber,
        expirySeconds: Math.max(Math.floor((existing.expiresAt.getTime() - Date.now()) / 1000), 1),
      });
      logSecurityEvent("PATIENT_SHARE_RECEIVED", req, { facilityId, counter: counterCode, token: existing.tokenNumber, repeat: true });
      return;
    }

    if ((await prisma.patientShare.count({ where: { facilityId, expiresAt: { gt: now } } })) >= MAX_PENDING_PER_FACILITY) {
      logSecurityEvent("PATIENT_SHARE_REJECTED", req, { facilityId, reason: "queue_full" });
      await reply({ ok: false, code: GENERIC_FAILURE, message: "The registration desk is busy. Please try again in a few minutes." });
      return;
    }

    const abhaNumber = abhaNumberOf(patient.abhaNumber);
    const tokenNumber = await nextToken(facilityId, counterCode);
    const address = patient.address ?? null;

    const share = await prisma.patientShare.create({
      data: {
        facilityId,
        environment,
        counterCode,
        tokenNumber,
        requestId,
        abhaNumber,
        abhaAddress,
        name: patient.name,
        gender: patient.gender ? patient.gender.trim().toUpperCase().slice(0, 1) : null,
        dayOfBirth: intOrNull(patient.dayOfBirth, 1, 31),
        monthOfBirth: intOrNull(patient.monthOfBirth, 1, 12),
        yearOfBirth: year,
        addressLine: address?.line?.slice(0, 300) ?? null,
        district: address?.district?.slice(0, 80) ?? null,
        state: address?.state?.slice(0, 80) ?? null,
        pincode: address?.pincode?.slice(0, 10) ?? null,
        phone: patient.phoneNumber?.slice(0, 20) ?? null,
        matchedPatientId: await findLinkedPatient(facilityId, abhaNumber, abhaAddress),
        expiresAt: new Date(now.getTime() + SHARE_VALIDITY_SECONDS * 1000),
      },
    });

    try {
      await reply({ ok: true, abhaAddress, counterCode, tokenNumber, expirySeconds: SHARE_VALIDITY_SECONDS });
    } catch (error) {
      // The patient never got their token, so do not leave a phantom entry in the staff queue.
      await prisma.patientShare.delete({ where: { id: share.id } }).catch(() => undefined);
      throw error;
    }
    logSecurityEvent("PATIENT_SHARE_RECEIVED", req, { facilityId, counter: counterCode, token: tokenNumber, matched: share.matchedPatientId !== null });
  } catch (error) {
    if (isUniqueViolation(error)) return; // duplicate delivery of the same share
    logSecurityEvent("PATIENT_SHARE_FAILED", req, { facilityId, reason: error instanceof Error ? error.message.slice(0, 150) : "unknown" });
  }
};

// ---------------------------------------------------------------------------
// staff side
// ---------------------------------------------------------------------------

const livePending = (facilityId: string) => ({ facilityId, expiresAt: { gt: new Date() } });

export const listSharesService = async (facilityId: string) => {
  const shares = await prisma.patientShare.findMany({ where: livePending(facilityId), orderBy: { receivedAt: "asc" } });
  const matchedIds = [...new Set(shares.map((s) => s.matchedPatientId).filter((id): id is string => id !== null))];
  const matched = matchedIds.length
    ? await prisma.patient.findMany({ where: { id: { in: matchedIds }, facilityId }, select: { id: true, name: true } })
    : [];

  return shares.map((s) => ({
    id: s.id,
    counterCode: s.counterCode,
    tokenNumber: s.tokenNumber,
    name: s.name,
    gender: s.gender,
    dayOfBirth: s.dayOfBirth,
    monthOfBirth: s.monthOfBirth,
    yearOfBirth: s.yearOfBirth,
    abhaNumber: s.abhaNumber,
    abhaAddress: s.abhaAddress,
    phone: s.phone,
    address: [s.addressLine, s.district, s.state, s.pincode].filter(Boolean).join(", ") || null,
    receivedAt: s.receivedAt,
    expiresAt: s.expiresAt,
    matchedPatient: matched.find((p) => p.id === s.matchedPatientId) ?? null,
  }));
};

const findLiveShare = async (shareId: string, facilityId: string) => {
  const share = await prisma.patientShare.findFirst({ where: { id: shareId, ...livePending(facilityId) } });
  if (!share) {
    throw new ApiError(404, "This shared profile has expired or was already handled. Ask the patient to scan the counter QR code again.", [], "SHARE_NOT_FOUND");
  }
  return share;
};

export const dismissShareService = async (shareId: string, facilityId: string) => {
  const share = await findLiveShare(shareId, facilityId);
  await prisma.patientShare.delete({ where: { id: share.id } });
};

const last10Digits = (value: string | null) => {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
};

// 01-01 is how a year-only birth date is stored, so it is not a real date of birth (same rule as fillPatientFromAbha)
const dateOfBirthOf = (share: { dayOfBirth: number | null; monthOfBirth: number | null; yearOfBirth: number }) => {
  const { dayOfBirth: d, monthOfBirth: m, yearOfBirth: y } = share;
  if (!d || !m || (d === 1 && m === 1)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
};

/**
 * Staff confirm a shared profile: create the patient (and link the ABHA when its number was shared). No OTP is
 * needed because the person consented in their own app and ABDM delivered the profile. If the ABHA is already
 * linked to a patient here, that patient is returned and nothing new is created.
 */
export const registerShareService = async (shareId: string, facilityId: string, phoneOverride?: string) => {
  const share = await findLiveShare(shareId, facilityId);

  const linkedId = await findLinkedPatient(facilityId, share.abhaNumber, share.abhaAddress);
  if (linkedId) {
    await prisma.patientShare.delete({ where: { id: share.id } });
    return { patientId: linkedId, created: false, abhaLinked: true };
  }

  const phone = phoneOverride ?? last10Digits(share.phone);
  if (!phone) {
    throw new ApiError(400, "The shared profile has no usable mobile number. Enter the patient's mobile number to register them.", [], "PHONE_REQUIRED");
  }

  if (share.abhaNumber) {
    const owner = await prisma.abhaPatient.findUnique({ where: { abhaNumber: share.abhaNumber }, select: { id: true } });
    if (owner) throw new ApiError(409, "This ABHA is already linked to a patient at another facility.", [], "ABHA_LINKED_TO_OTHER_PATIENT");
  }

  const created = await prisma.$transaction(async (tx) => {
    const gender = normalizeGender(share.gender);
    const patient = await tx.patient.create({
      data: {
        name: cleanText(share.name, 100) ?? share.name,
        phone,
        facilityId,
        dateOfBirth: dateOfBirthOf(share),
        ...(gender ? { gender } : {}),
        address: cleanText([share.addressLine, share.district, share.state, share.pincode].filter(Boolean).join(", ")) ?? null,
        stateName: cleanText(share.state, 80) ?? null,
        districtName: cleanText(share.district, 80) ?? null,
      },
    });
    if (share.abhaNumber) {
      await tx.abhaPatient.create({ data: { patientId: patient.id, abhaNumber: share.abhaNumber, abhaAddress: share.abhaAddress } });
    }
    await tx.patientShare.delete({ where: { id: share.id } });
    return patient;
  });

  return { patientId: created.id, created: true, abhaLinked: share.abhaNumber !== null };
};

/** What the staff screen needs to print a counter QR code. */
export const getShareConfigService = async (facilityId: string, environment: Environment) => {
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { hfrId: true } });
  if (!facility) throw new ApiError(404, "Facility not found");
  const qrBaseUrl =
    environment === "SANDBOX"
      ? process.env.SHARE_QR_SANDBOX_URL || "https://phrsbx.abdm.gov.in/share-profile"
      : process.env.SHARE_QR_PRODUCTION_URL || "https://phr.abdm.gov.in/share-profile";
  return { hipId: facility.hfrId, qrBaseUrl, validityMinutes: SHARE_VALIDITY_SECONDS / 60 };
};

/** Shares are personal data: delete the ones nobody claimed in time, and old token counters. */
export const purgeExpiredShares = async () => {
  const shares = await prisma.patientShare.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - PURGE_GRACE_MS) } } });
  const counters = await prisma.shareTokenCounter.deleteMany({ where: { tokenDate: { lt: new Date(today().getTime() - 3 * 86_400_000) } } });
  return { shares: shares.count, counters: counters.count };
};

import { prisma } from "../../../config/db.js";
import { ApiError } from "../../../common/errors/appError.js";
import { generateAbdmSessionToken } from "../../../common/client/facility.client.js";
import { decrypt, encryptWithAbdmPublicKey } from "../../../common/utils/encryption.js";
import { abhaFullName, findAbhaMismatches, parseAbhaDob, PENDING_PATIENT_NAME, type AbhaDemographics } from "../../../common/utils/abhaMatch.js";
import type { AbhaTokenKind } from "../../../common/utils/abdmCookies.js";
import { getAbdmPublicKey, requestAadhaarOtp, aadharCreationClient, requestExistingAbhaAadhaarOtp, verifyExistingAbhaAadhaarOtp, getExistingAbhaProfile, requestExistingAbhaMobileOtp, verifyExistingAbhaMobileOtp, verifyExistingAbhaUser, generateAbhaQr, getAbhaCard, requestEnrolMobileOtp, verifyEnrolMobileOtp, getAbhaAddressSuggestions, createAbhaAddress, requestAbhaNumberOtp, verifyAbhaNumberOtp, ABHA_ENROLLMENT_CONSENT, HOSPITAL_LINK_CONSENT, getCmId, requestProfileContactOtp, verifyProfileContactOtp, abhaLogout, searchAbhaAddress, requestAbhaAddressOtp, verifyAbhaAddressOtp, getPhrProfile, getPhrCard, type AbhaLoginChannel, type ProfileContactType } from "../../../common/client/abdm.client.js";

type Environment = "SANDBOX" | "PRODUCTION";

const OTP_VALIDITY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

// ABDM expects Aadhaar / mobile / OTP values encrypted with its current public key.
const encryptForAbdm = async (environment: Environment, abdmAccessToken: string, value: string) => {
  const { publicKey } = await getAbdmPublicKey(environment, abdmAccessToken);

  if (!publicKey) {
    throw new ApiError(502, "Failed to retrieve ABDM public key");
  }

  return encryptWithAbdmPublicKey(value, publicKey);
};

const findPatientInFacility = async (patientId: string, facilityId: string) => {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, facilityId },
    include: { abha: true },
  });

  if (!patient) {
    throw new ApiError(404, "Patient not found", [], "PATIENT_NOT_FOUND");
  }

  return patient;
};

// Loads a pending transaction and enforces facility, purpose, status and expiry.
const loadPendingTransaction = async (transactionId: string, facilityId: string, purpose: "ENROLLMENT" | "VERIFICATION" | "PROFILE_UPDATE") => {
  const transaction = await prisma.abhaTransaction.findUnique({
    where: { id: transactionId },
  });

  if (!transaction) {
    throw new ApiError(404, "ABHA transaction not found");
  }

  if (transaction.facilityId !== facilityId) {
    throw new ApiError(403, "Transaction does not belong to this facility");
  }

  if (transaction.purpose !== purpose) {
    throw new ApiError(400, "Invalid transaction purpose");
  }

  if (transaction.status !== "PENDING") {
    throw new ApiError(400, `This OTP request was already used (${transaction.status.toLowerCase()}). Request a new OTP to continue.`, [], "TRANSACTION_USED");
  }

  if (transaction.expiresAt <= new Date()) {
    await prisma.abhaTransaction.update({
      where: { id: transaction.id },
      data: { status: "EXPIRED" },
    });

    throw new ApiError(400, "This OTP request has expired. Request a new OTP and try again.", [], "OTP_EXPIRED");
  }

  return transaction;
};

const setTransactionStatus = (id: string, status: "COMPLETED" | "FAILED", extra: Record<string, unknown> = {}) =>
  prisma.abhaTransaction.update({ where: { id }, data: { status, ...extra } });

// Links an ABHA to the patient, refusing to attach one ABHA to two patients.
// ABDM has already authenticated the user at this point, so a conflict is recorded as FAILED.
// The patient's name and date of birth must also agree with the ABHA's demographics (abhaMatch.ts).
const linkAbhaToPatient = async (
  transactionId: string,
  patientId: string,
  abhaNumber: string,
  abhaAddress: string | null,
  demographics: AbhaDemographics,
  // The patient was registered with this ABHA and a mobile number: that number must be the one on the ABHA.
  requireMobileMatch = false,
) => {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { facilityId: true, name: true, dateOfBirth: true, phone: true, gender: true, address: true, stateName: true, districtName: true },
  });
  if (!patient) {
    throw new ApiError(404, "Patient not found", [], "PATIENT_NOT_FOUND");
  }

  // A patient registered from an ABHA number / address has no name of their own yet, so there is nothing to compare.
  const namePending = patient.name === PENDING_PATIENT_NAME;
  // Details typed at registration that differ from the ABHA are replaced by the ABHA's (the ABHA is the verified source).
  const mismatches = findAbhaMismatches(patient, demographics).filter((field) => !(namePending && field === "name"));

  // This ABHA already belongs to a patient of this hospital: carry on with that record instead of making a second one.
  const existing = await prisma.abhaPatient.findUnique({ where: { abhaNumber } });
  if (existing && existing.patientId !== patientId) {
    const owner = await prisma.patient.findUnique({ where: { id: existing.patientId }, select: { facilityId: true } });
    if (!owner || owner.facilityId !== patient.facilityId) {
      await setTransactionStatus(transactionId, "FAILED");
      throw new ApiError(409, "This ABHA is already linked to a patient at another hospital", [], "ABHA_LINKED_TO_OTHER_PATIENT");
    }
    await prisma.abhaTransaction.update({ where: { id: transactionId }, data: { patientId: existing.patientId } });
    // drop the blank record that was only created for this attempt
    if (namePending && patient.phone === "") await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
    return { ...existing, mobileMatchesRecord: undefined as boolean | undefined, detailsUpdated: [] as string[], alreadyRegistered: true };
  }

  if (requireMobileMatch && mobileMatchesRecord(patient.phone, demographics.mobile) === false) {
    await setTransactionStatus(transactionId, "FAILED");
    const abhaMobile = String(demographics.mobile);
    throw new ApiError(
      422,
      `The mobile number entered (ending ${last10(patient.phone).slice(-4)}) is not the one registered with this ABHA (ending ${last10(abhaMobile).slice(-4)}), so nothing was linked. ` +
        "Check the mobile number, or check that this is the right ABHA number / address.",
      [],
      "ABHA_MOBILE_MISMATCH",
    );
  }

  const patientAbha = await prisma.abhaPatient.findUnique({ where: { patientId } });

  if (patientAbha && patientAbha.abhaNumber !== abhaNumber) {
    await setTransactionStatus(transactionId, "FAILED");
    throw new ApiError(409, "Patient is already linked to a different ABHA", [], "PATIENT_ALREADY_LINKED");
  }

  const abhaPatient = await prisma.abhaPatient.upsert({
    where: { patientId },
    update: { abhaAddress },
    create: { patientId, abhaNumber, abhaAddress },
  });

  await fillPatientFromAbha(patientId, patient, demographics);
  if (namePending) {
    const abhaName = cleanText(abhaFullName(demographics), 100);
    if (abhaName) await prisma.patient.update({ where: { id: patientId }, data: { name: abhaName } });
  }

  // Registered with an ABHA alone, so no mobile number yet: take the ABHA's (nothing to compare it with).
  const noPhoneYet = patient.phone === "";
  if (noPhoneYet) {
    const abhaMobile = last10(String(demographics.mobile ?? ""));
    if (/^[6-9]\d{9}$/.test(abhaMobile)) await prisma.patient.update({ where: { id: patientId }, data: { phone: abhaMobile } });
  }

  // Name / date of birth typed at registration that the ABHA contradicts are replaced, and the record says so.
  const detailsUpdated: string[] = [];
  if (mismatches.length > 0) {
    const data: { name?: string; dateOfBirth?: Date; abhaUpdateNote?: string } = {};
    const was: string[] = [];
    const abhaName = cleanText(abhaFullName(demographics), 100);
    if (mismatches.includes("name") && abhaName) {
      data.name = abhaName;
      was.push(`name (was "${patient.name}")`);
      detailsUpdated.push("name");
    }
    const abhaDob = parseAbhaDob(demographics);
    if (mismatches.includes("date of birth") && abhaDob) {
      data.dateOfBirth = new Date(Date.UTC(abhaDob.year, (abhaDob.month ?? 1) - 1, abhaDob.day ?? 1));
      was.push(`date of birth (was ${patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : "not set"})`);
      detailsUpdated.push("date of birth");
    }
    if (was.length > 0) {
      data.abhaUpdateNote = `Details updated from the ABHA on ${new Date().toISOString().slice(0, 10)}: ${was.join(", ")}.`;
      await prisma.patient.update({ where: { id: patientId }, data });
    }
  }

  return {
    ...abhaPatient,
    mobileMatchesRecord: noPhoneYet ? undefined : mobileMatchesRecord(patient.phone, demographics.mobile),
    detailsUpdated,
    alreadyRegistered: false,
  };
};

const last10 = (value: string) => digitsOnly(value).slice(-10);

// undefined when ABDM did not return a mobile, so the UI only asks about a real difference
const mobileMatchesRecord = (recordPhone: string, abhaMobile: unknown): boolean | undefined =>
  typeof abhaMobile === "string" && digitsOnly(abhaMobile).length >= 10 ? last10(abhaMobile) === last10(recordPhone) : undefined;

export const normalizeGender = (value: unknown): "M" | "F" | "O" | undefined => {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "m" || v === "male") return "M";
  if (v === "f" || v === "female") return "F";
  if (v === "o" || v === "other" || v === "t" || v === "transgender") return "O";
  return undefined;
};

export const cleanText = (value: unknown, max = 300): string | undefined =>
  typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : undefined;

// After a successful link, copy gender / address / state / district (and the date of birth when the record
// has none) from the ABHA profile. Only empty fields are filled: what the hospital already holds is never overwritten.
const fillPatientFromAbha = async (
  patientId: string,
  patient: { dateOfBirth: Date | null; gender: string | null; address: string | null; stateName: string | null; districtName: string | null },
  demographics: AbhaDemographics,
) => {
  const data: { gender?: string; address?: string; stateName?: string; districtName?: string; dateOfBirth?: Date } = {};

  if (!patient.gender) {
    const gender = normalizeGender(demographics.gender);
    if (gender) data.gender = gender;
  }
  if (!patient.address) {
    const address = cleanText(demographics.address);
    if (address) data.address = address;
  }
  if (!patient.stateName) {
    const state = cleanText(demographics.stateName ?? demographics.state, 80);
    if (state) data.stateName = state;
  }
  if (!patient.districtName) {
    const district = cleanText(demographics.districtName ?? demographics.district, 80);
    if (district) data.districtName = district;
  }
  if (!patient.dateOfBirth) {
    const dob = parseAbhaDob(demographics);
    // 01-01 is how UIDAI stores a year-only birth date, so it is not a real date of birth
    if (dob && dob.month && dob.day && !(dob.month === 1 && dob.day === 1)) {
      data.dateOfBirth = new Date(Date.UTC(dob.year, dob.month - 1, dob.day));
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.patient.update({ where: { id: patientId }, data });
  }
};

// The X-token calls (profile / QR) answer 401 when the token is missing or stale.
// That is an ABHA-session problem, not an ABDM-gateway one, so word it accordingly.
const asAbhaSessionError = (error: unknown): never => {
  if (error instanceof ApiError && error.statusCode === 401) {
    throw new ApiError(401, "ABHA verification session expired", [], "ABHA_SESSION_EXPIRED");
  }
  throw error;
};

const digitsOnly = (value: string) => value.replace(/\D/g, "");

// ---------------------------------------------------------------------------
// ABDM gateway session
// ---------------------------------------------------------------------------

export const abdmTokenRetrievalService = async (facilityId: string, userId: string, environment: Environment) => {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.facilityId !== facilityId) {
    throw new ApiError(401, "User does not belong to the specified facility");
  }

  const facilityAbdm = await prisma.facilityAbdmData.findUnique({
    where: {
      facilityId_environment: {
        facilityId: facilityId,
        environment: environment
      }
    }
  })

  if (!facilityAbdm) {
    throw new ApiError(404, "configure abdm details before this action.");
  }

  const clientId = facilityAbdm.clientId;
  const clientSecret = decrypt(facilityAbdm.clientSecret);

  const abdmResponse = await generateAbdmSessionToken({ clientId, clientSecret, environment })

  if (!abdmResponse.accessToken || !abdmResponse.refreshToken) {
    throw new ApiError(400, "ABDM authentication failed");
  }

  return {
    abdmAccessToken: abdmResponse.accessToken as string,
    abdmRefreshToken: abdmResponse.refreshToken as string,
    expiresIn: abdmResponse.expiresIn as number | undefined,
    refreshExpiresIn: abdmResponse.refreshExpiresIn as number | undefined,
  };

}

// ---------------------------------------------------------------------------
// creation - aadhaar
// ---------------------------------------------------------------------------

export const aadhaarOtpRequestService = async (patientId: string, facilityId: string, abdmAccessToken: string, environment: Environment, aadhaar: string, consentLanguage = "en") => {
  // Make sure patient belongs to authenticated user's facility
  const patient = await findPatientInFacility(patientId, facilityId);

  if (patient.abha) {
    throw new ApiError(409, "Patient already has an ABHA linked", [], "PATIENT_ALREADY_LINKED");
  }

  const encryptedAadhaar = await encryptForAbdm(environment, abdmAccessToken, aadhaar);

  // Ask ABDM to send the OTP
  const abdmResponse = await requestAadhaarOtp({
    accessToken: abdmAccessToken,
    encryptedAadhaar,
    environment,
  });

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId: patient.id,
      facilityId,
      purpose: "ENROLLMENT",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
      consentCode: ABHA_ENROLLMENT_CONSENT.code,
      consentVersion: ABHA_ENROLLMENT_CONSENT.version,
      consentAcceptedAt: new Date(),
      consentLanguage,
    },
  });

  return {
    transactionId: transaction.id,
    txnId: transaction.txnId,
    message: abdmResponse.message,
  };
};


export const aadhaarOtpVerifyService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string, mobile: string) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "ENROLLMENT");

  const existingLink = await prisma.abhaPatient.findUnique({ where: { patientId: transaction.patientId } });
  if (existingLink) {
    throw new ApiError(409, "Patient already has an ABHA linked", [], "PATIENT_ALREADY_LINKED");
  }

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await aadharCreationClient({
    accessToken: abdmAccessToken,
    txnId: transaction.txnId,
    encryptedOtp,
    mobile,
    environment,
  });

  // Make sure ABDM actually returned an ABHA number
  const abhaNumber = abdmResponse?.ABHAProfile?.ABHANumber as string | undefined;
  if (!abhaNumber) {
    throw new ApiError(502, "ABDM enrollment failed");
  }

  const abhaAddress: string | null =
    abdmResponse.ABHAProfile.phrAddress?.[0] ?? abdmResponse.ABHAProfile.preferredAbhaAddress ?? null;

  const abhaPatient = await linkAbhaToPatient(transaction.id, transaction.patientId, abhaNumber, abhaAddress, abdmResponse.ABHAProfile);

  // ABDM treats the mobile as verified when it is the Aadhaar-linked one; otherwise it must be verified by OTP.
  const mobileVerified = digitsOnly(String(abdmResponse.ABHAProfile.mobile ?? "")) === digitsOnly(mobile);

  // Mark transaction as completed; keep ABDM's enrolment txnId for the mobile-verification / address follow-ups.
  await setTransactionStatus(transaction.id, "COMPLETED", {
    consentCode: ABHA_ENROLLMENT_CONSENT.code,
    consentVersion: ABHA_ENROLLMENT_CONSENT.version,
    consentAcceptedAt: new Date(),
    enrolTxnId: typeof abdmResponse.txnId === "string" ? abdmResponse.txnId : null,
    mobileVerified,
  });

  // Return only what the application needs (not the ABDM photo/address payload).
  return {
    patientId: abhaPatient.patientId,
    detailsUpdated: abhaPatient.detailsUpdated,
    alreadyRegistered: abhaPatient.alreadyRegistered,
    abhaNumber: abhaPatient.abhaNumber,
    abhaAddress: abhaPatient.abhaAddress,
    isNew: Boolean(abdmResponse.isNew),
    transactionId: transaction.id,
    mobileVerified,
    hasFollowUp: typeof abdmResponse.txnId === "string",
    // Enrolment already authenticates the user; keep the X-token so the profile / QR work straight away.
    xToken: (abdmResponse.tokens?.token as string | undefined) ?? null,
    xTokenExpiresIn: abdmResponse.tokens?.expiresIn as number | undefined,
  };
};

// Shared by every "login with an OTP, then link" flow (Aadhaar, ABHA number): ABDM answers with a T-token and the
// account list; the X-token is issued by "verify user" for the chosen ABHA. Then the profile is read, the patient's
// name/DOB are compared with it, and the ABHA is linked.
const finishLoginVerification = async (
  transaction: { id: string; patientId: string; txnId: string },
  abdmResponse: { txnId?: string; authResult?: string; message?: string; token?: string; expiresIn?: number; accounts?: { ABHANumber: string }[] },
  abdmAccessToken: string,
  environment: Environment,
  requireMobileMatch = false,
  // Aadhaar login: a person with no ABHA still gets an OTP and passes it, but there is no account behind it.
  requireAccount = false,
) => {
  if (abdmResponse.authResult !== "success") {
    throw new ApiError(422, abdmResponse.message || "The OTP could not be verified. Check it and try again.", [], "OTP_INVALID");
  }

  if (!abdmResponse.token) {
    throw new ApiError(502, "ABDM authentication succeeded but no token was returned");
  }

  // ABDM returns a T-token plus the ABHA account list. The profile / QR APIs need an X-token,
  // which is issued by "verify user" for the chosen ABHA.
  const accounts = abdmResponse.accounts ?? [];
  if (requireAccount && accounts.length === 0) {
    await setTransactionStatus(transaction.id, "FAILED");
    throw new ApiError(404, "No ABHA found for this Aadhaar number.", [], "ABHA_NOT_FOUND");
  }
  let xToken = abdmResponse.token;
  let expiresIn: number | undefined = abdmResponse.expiresIn;

  if (accounts.length > 1) {
    throw new ApiError(409, "Multiple ABHA accounts exist for this Aadhaar. Use mobile-number linking to choose one.", [], "MULTIPLE_ACCOUNTS");
  }

  if (accounts.length === 1) {
    // Some logins (ABHA number) already return the session token itself, and ABDM then answers "Invalid T-token"
    // when it is exchanged. The OTP is spent by this point, so use the token as it is rather than fail the link.
    const verifiedUser = await verifyExistingAbhaUser(
      environment,
      abdmAccessToken,
      abdmResponse.token,
      accounts[0]!.ABHANumber,
      transaction.txnId,
    ).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "ABHA_SESSION_EXPIRED") return null;
      throw error;
    });

    if (verifiedUser) {
      if (!verifiedUser.token) {
        throw new ApiError(502, "ABDM verification succeeded but no session token was returned");
      }
      xToken = verifiedUser.token;
      expiresIn = verifiedUser.expiresIn;
    }
  }

  const profile = await getExistingAbhaProfile({
    accessToken: abdmAccessToken,
    xToken,
    environment,
  }).catch(asAbhaSessionError);

  if (!profile?.ABHANumber) {
    throw new ApiError(502, "ABDM profile did not contain an ABHA number");
  }

  const abhaPatient = await linkAbhaToPatient(
    transaction.id,
    transaction.patientId,
    profile.ABHANumber,
    profile.preferredAbhaAddress ?? null,
    profile,
    requireMobileMatch,
  );

  await setTransactionStatus(transaction.id, "COMPLETED");

  return {
    patientId: abhaPatient.patientId,
    detailsUpdated: abhaPatient.detailsUpdated,
    alreadyRegistered: abhaPatient.alreadyRegistered,
    transactionId: transaction.id,
    message: abdmResponse.message,
    abhaNumber: abhaPatient.abhaNumber,
    abhaAddress: abhaPatient.abhaAddress,
    mobileMatchesRecord: abhaPatient.mobileMatchesRecord,
    token: xToken,
    expiresIn,
  };
};


// ---------------------------------------------------------------------------
// verification (link existing ABHA) - aadhaar
// ---------------------------------------------------------------------------

export const requestExistingAbhaAadhaarOtpService = async (patientId: string, facilityId: string, abdmAccessToken: string, environment: Environment, aadhaar: string, consentLanguage = "en") => {
  const patient = await findPatientInFacility(patientId, facilityId);

  const encryptedAadhaar = await encryptForAbdm(environment, abdmAccessToken, aadhaar);

  const abdmResponse = await requestExistingAbhaAadhaarOtp({
    accessToken: abdmAccessToken,
    encryptedAadhaar,
    environment,
  });

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId: patient.id,
      facilityId,
      purpose: "VERIFICATION",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
      consentCode: HOSPITAL_LINK_CONSENT.code,
      consentVersion: HOSPITAL_LINK_CONSENT.version,
      consentAcceptedAt: new Date(),
      consentLanguage,
    },
  });

  return {
    transactionId: transaction.id,
    txnId: transaction.txnId,
    message: abdmResponse.message,
  };
};


export const verifyExistingAbhaAadhaarOtpService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "VERIFICATION");

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyExistingAbhaAadhaarOtp({
    accessToken: abdmAccessToken,
    txnId: transaction.txnId,
    encryptedOtp,
    environment,
  });

  return finishLoginVerification(transaction, abdmResponse, abdmAccessToken, environment, false, true);
};

// ---------------------------------------------------------------------------
// verification (link existing ABHA) - mobile number
// ---------------------------------------------------------------------------

//step 1 - request otp
export const requestExistingAbhaMobileOtpService = async (patientId: string, facilityId: string, abdmAccessToken: string, environment: Environment, mobile: string, consentLanguage = "en") => {
  await findPatientInFacility(patientId, facilityId);

  const encryptedMobile = await encryptForAbdm(environment, abdmAccessToken, mobile);

  const abdmResponse = await requestExistingAbhaMobileOtp(environment, abdmAccessToken, encryptedMobile);

  if (!abdmResponse?.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId,
      facilityId,
      purpose: "VERIFICATION",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
      consentCode: HOSPITAL_LINK_CONSENT.code,
      consentVersion: HOSPITAL_LINK_CONSENT.version,
      consentAcceptedAt: new Date(),
      consentLanguage,
    },
  });

  return {
    transactionId: transaction.id,
    txnId: abdmResponse.txnId,
    message: abdmResponse.message,
  };
};

//step 2 - verify otp
export const verifyExistingAbhaMobileOtpService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "VERIFICATION");

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyExistingAbhaMobileOtp(environment, abdmAccessToken, transaction.txnId, encryptedOtp);

  if (abdmResponse?.authResult !== "success") {
    throw new ApiError(422, abdmResponse?.message || "The OTP could not be verified. Check it and try again.", [], "OTP_INVALID");
  }

  if (!abdmResponse?.token) {
    throw new ApiError(502, "ABDM did not return the authentication token");
  }

  if (!abdmResponse?.accounts?.length) {
    throw new ApiError(404, "We did not find any ABHA number linked to this mobile number. Please use the ABHA-linked mobile number, or create a new ABHA.", [], "ABHA_NOT_FOUND");
  }

  // One mobile number can hold several ABHAs (a family sharing a phone). The ones whose name / date of birth agree
  // with the patient being registered are flagged so the screen can pick the right one without asking.
  const patient = await prisma.patient.findUnique({ where: { id: transaction.patientId }, select: { name: true, dateOfBirth: true } });
  const accounts = abdmResponse.accounts as (AbhaDemographics & { ABHANumber: string })[];
  const matchedAbhaNumbers =
    patient && patient.name !== PENDING_PATIENT_NAME
      ? accounts.filter((account) => abhaFullName(account) !== "" && findAbhaMismatches(patient, account).length === 0).map((account) => account.ABHANumber)
      : [];

  return {
    transactionId: transaction.id,
    txnId: abdmResponse.txnId,
    token: abdmResponse.token as string,
    expiresIn: abdmResponse.expiresIn as number | undefined,
    accounts,
    matchedAbhaNumbers,
    message: abdmResponse.message,
  };
};

//step 3 - verify user and link internally
export const verifyExistingAbhaMobileUserService = async (abhaNumber: string, transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, tToken: string) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "VERIFICATION");

  const abdmResponse = await verifyExistingAbhaUser(
    environment,
    abdmAccessToken,
    tToken,
    abhaNumber,
    transaction.txnId,
  );

  if (!abdmResponse?.token) {
    throw new ApiError(502, "ABDM verification succeeded but no session token was returned");
  }

  // Step 3 generates the final ABHA session (X-token)
  const xToken = abdmResponse.token as string;

  // Get authoritative ABHA profile using the generated session
  const profile = await getExistingAbhaProfile({
    accessToken: abdmAccessToken,
    xToken,
    environment,
  }).catch(asAbhaSessionError);

  if (!profile?.ABHANumber) {
    throw new ApiError(502, "ABDM profile did not contain an ABHA number");
  }

  const abhaPatient = await linkAbhaToPatient(
    transaction.id,
    transaction.patientId,
    profile.ABHANumber,
    profile.preferredAbhaAddress ?? null,
    profile,
  );

  await setTransactionStatus(transaction.id, "COMPLETED");

  return {
    patientId: abhaPatient.patientId,
    detailsUpdated: abhaPatient.detailsUpdated,
    alreadyRegistered: abhaPatient.alreadyRegistered,
    transactionId: transaction.id,
    token: xToken,
    expiresIn: abdmResponse.expiresIn as number | undefined,
    message: "ABHA verified and linked successfully",

    abhaNumber: abhaPatient.abhaNumber,
    abhaAddress: abhaPatient.abhaAddress,
    mobileMatchesRecord: abhaPatient.mobileMatchesRecord,

    name: profile.name,
    gender: profile.gender,
    dob: profile.dob,
    kycVerified: profile.kycVerified,
  };
};

// ---------------------------------------------------------------------------
// profile + QR (X-token is bound to one patient, see abdmCookies.ts)
// ---------------------------------------------------------------------------

const requireLinkedAbha = async (patientId: string, facilityId: string) => {
  const patient = await findPatientInFacility(patientId, facilityId);

  if (!patient.abha) {
    throw new ApiError(404, "This patient has no ABHA linked", [], "NO_ABHA_LINKED");
  }

  return patient.abha;
};

//generate QR code
export const generateAbhaQrService = async (patientId: string, facilityId: string, abdmAccessToken: string, abhaXToken: string, environment: Environment, kind: AbhaTokenKind = "abha") => {
  await requireLinkedAbha(patientId, facilityId);

  if (kind === "phr") {
    throw new ApiError(422, "The QR code is not available after an ABHA-address verification. Verify with the ABHA number, Aadhaar or mobile to see the QR.", [], "QR_NOT_AVAILABLE");
  }

  return generateAbhaQr({ accessToken: abdmAccessToken, xToken: abhaXToken, environment }).catch(asAbhaSessionError);
};

//GET abha profile
export const getAbhaProfileService = async (patientId: string, facilityId: string, accessToken: string, xToken: string, environment: Environment, kind: AbhaTokenKind = "abha") => {
  const linked = await requireLinkedAbha(patientId, facilityId);

  if (kind === "phr") {
    const phr = await getPhrProfile({ accessToken, xToken, environment }).catch(asAbhaSessionError);
    const phrNumber = fullAbhaNumber(phr.abhaNumber ?? phr.healthIdNumber);
    const phrAddress = typeof phr.abhaAddress === "string" ? phr.abhaAddress.trim().toLowerCase() : undefined;
    const sameNumber = phrNumber !== undefined && digitsOnly(phrNumber) === digitsOnly(linked.abhaNumber);
    const sameAddress = phrAddress !== undefined && linked.abhaAddress !== null && phrAddress === linked.abhaAddress.trim().toLowerCase();

    // Never show a profile that belongs to a different ABHA than the one linked to this patient.
    if (!sameNumber && !sameAddress) {
      throw new ApiError(401, "ABHA verification session expired", [], "ABHA_SESSION_EXPIRED");
    }

    // Same field names the rest of the app reads from /v3/profile/account.
    return {
      ...phr,
      ABHANumber: phrNumber ?? linked.abhaNumber,
      preferredAbhaAddress: phr.abhaAddress,
      name: phr.fullName ?? phr.name,
      dob: phr.dateOfBirth,
      kycVerified: typeof phr.kycStatus === "string" ? phr.kycStatus.toUpperCase() === "VERIFIED" : undefined,
    };
  }

  const profile = await getExistingAbhaProfile({ accessToken, xToken, environment }).catch(asAbhaSessionError);

  if (!profile?.ABHANumber) {
    throw new ApiError(502, "ABDM profile did not contain an ABHA number");
  }

  // Never show a profile that belongs to a different ABHA than the one linked to this patient.
  if (digitsOnly(profile.ABHANumber) !== digitsOnly(linked.abhaNumber)) {
    throw new ApiError(401, "ABHA verification session expired", [], "ABHA_SESSION_EXPIRED");
  }

  return profile;
};

// ---------------------------------------------------------------------------
// ABHA card
// ---------------------------------------------------------------------------

export const getAbhaCardService = async (patientId: string, facilityId: string, abdmAccessToken: string, abhaXToken: string, environment: Environment, kind: AbhaTokenKind = "abha") => {
  await requireLinkedAbha(patientId, facilityId);

  if (kind === "phr") {
    return getPhrCard({ accessToken: abdmAccessToken, xToken: abhaXToken, environment }).catch(asAbhaSessionError);
  }

  return getAbhaCard({ accessToken: abdmAccessToken, xToken: abhaXToken, environment }).catch(asAbhaSessionError);
};

// ---------------------------------------------------------------------------
// enrolment follow-ups: verify the communication mobile, then choose an ABHA address.
// They continue on ABDM's enrolment txnId, kept on the COMPLETED ENROLLMENT transaction.
// ---------------------------------------------------------------------------

const FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000;

const loadEnrolmentForFollowUp = async (transactionId: string, facilityId: string) => {
  const transaction = await prisma.abhaTransaction.findUnique({ where: { id: transactionId } });

  if (!transaction) {
    throw new ApiError(404, "ABHA transaction not found", [], "TRANSACTION_NOT_FOUND");
  }
  if (transaction.facilityId !== facilityId) {
    throw new ApiError(403, "Transaction does not belong to this facility");
  }
  if (transaction.purpose !== "ENROLLMENT" || transaction.status !== "COMPLETED" || !transaction.enrolTxnId) {
    throw new ApiError(400, "This ABHA was not created in this session, so it cannot be changed here.", [], "ENROLMENT_SESSION_INVALID");
  }
  if (Date.now() - transaction.updatedAt.getTime() > FOLLOW_UP_WINDOW_MS) {
    throw new ApiError(400, "The ABHA creation session has ended (30 minutes). The ABHA is created and linked; this step can no longer be done here.", [], "ENROLMENT_SESSION_EXPIRED");
  }

  return { ...transaction, enrolTxnId: transaction.enrolTxnId };
};

//step 1 - send an OTP to the mobile number to be linked with the new ABHA
export const requestEnrolMobileVerificationService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, mobile: string) => {
  const transaction = await loadEnrolmentForFollowUp(transactionId, facilityId);

  const encryptedMobile = await encryptForAbdm(environment, abdmAccessToken, mobile);

  const abdmResponse = await requestEnrolMobileOtp({
    accessToken: abdmAccessToken,
    txnId: transaction.enrolTxnId,
    encryptedMobile,
    environment,
  });

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  await prisma.abhaTransaction.update({
    where: { id: transaction.id },
    data: { mobileOtpTxnId: abdmResponse.txnId },
  });

  return { transactionId: transaction.id, message: abdmResponse.message };
};

//step 2 - verify that OTP
export const verifyEnrolMobileService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string) => {
  const transaction = await loadEnrolmentForFollowUp(transactionId, facilityId);

  if (!transaction.mobileOtpTxnId) {
    throw new ApiError(400, "Request an OTP for the mobile number first.", [], "OTP_NOT_REQUESTED");
  }

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyEnrolMobileOtp({
    accessToken: abdmAccessToken,
    txnId: transaction.mobileOtpTxnId,
    encryptedOtp,
    environment,
  });

  if (abdmResponse.authResult && abdmResponse.authResult !== "success") {
    throw new ApiError(422, abdmResponse.message || "The OTP could not be verified. Check it and try again.", [], "OTP_INVALID");
  }

  await prisma.abhaTransaction.update({
    where: { id: transaction.id },
    data: {
      mobileVerified: true,
      mobileOtpTxnId: null,
      // ABDM may hand back a fresh txnId to continue with (address creation)
      enrolTxnId: abdmResponse.txnId ?? transaction.enrolTxnId,
    },
  });

  return { transactionId: transaction.id, message: abdmResponse.message ?? "Mobile number verified" };
};

// ABHA address rules (NHA M1 sheet): 8-18 characters, letters/digits, at most one "." and one "_", not at the ends.
export const isValidAbhaAddressName = (value: string) =>
  /^(?=.{8,18}$)[a-z0-9]+([._][a-z0-9]+)*$/i.test(value) && (value.match(/\./g)?.length ?? 0) <= 1 && (value.match(/_/g)?.length ?? 0) <= 1;

export const getAbhaAddressSuggestionsService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment) => {
  const transaction = await loadEnrolmentForFollowUp(transactionId, facilityId);

  const abdmResponse = await getAbhaAddressSuggestions({
    accessToken: abdmAccessToken,
    txnId: transaction.enrolTxnId,
    environment,
  });

  return { suggestions: Array.isArray(abdmResponse.abhaAddressList) ? abdmResponse.abhaAddressList : [] };
};

export const createAbhaAddressService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, abhaAddress: string) => {
  const transaction = await loadEnrolmentForFollowUp(transactionId, facilityId);

  // Suggestions come back as "name@domain"; ABDM wants just the name part.
  const name = abhaAddress.split("@")[0] ?? "";
  if (!isValidAbhaAddressName(name)) {
    throw new ApiError(400, "ABHA address must be 8-18 characters: letters and numbers, with at most one dot and one underscore, not at the start or end.", [], "ABHA_ADDRESS_INVALID");
  }

  const abdmResponse = await createAbhaAddress({
    accessToken: abdmAccessToken,
    txnId: transaction.enrolTxnId,
    abhaAddress: name,
    environment,
  });

  const preferred = abdmResponse.preferredAbhaAddress ?? `${name}@${getCmId(environment)}`;

  await prisma.abhaPatient.update({
    where: { patientId: transaction.patientId },
    data: { abhaAddress: preferred },
  });

  return { abhaAddress: preferred };
};

// ---------------------------------------------------------------------------
// verification (link existing ABHA) - ABHA number, OTP via Aadhaar or via the ABHA's mobile
// ---------------------------------------------------------------------------

// Accepts "91-1234-5678-9012" or 14 digits; ABDM wants the hyphenated form.
export const formatAbhaNumber = (value: string) => {
  const d = value.replace(/\D/g, "");
  return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10, 14)}`;
};

export const requestAbhaNumberOtpService = async (patientId: string, facilityId: string, abdmAccessToken: string, environment: Environment, abhaNumber: string, channel: AbhaLoginChannel, consentLanguage = "en") => {
  const patient = await findPatientInFacility(patientId, facilityId);

  const encryptedAbhaNumber = await encryptForAbdm(environment, abdmAccessToken, formatAbhaNumber(abhaNumber));

  const abdmResponse = await requestAbhaNumberOtp({
    accessToken: abdmAccessToken,
    encryptedAbhaNumber,
    channel,
    environment,
  });

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId: patient.id,
      facilityId,
      purpose: "VERIFICATION",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
      consentCode: HOSPITAL_LINK_CONSENT.code,
      consentVersion: HOSPITAL_LINK_CONSENT.version,
      consentAcceptedAt: new Date(),
      consentLanguage,
    },
  });

  return {
    transactionId: transaction.id,
    message: abdmResponse.message,
  };
};

export const verifyAbhaNumberOtpService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string, channel: AbhaLoginChannel, requireMobileMatch = false) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "VERIFICATION");

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyAbhaNumberOtp({
    accessToken: abdmAccessToken,
    txnId: transaction.txnId,
    encryptedOtp,
    channel,
    environment,
  });

  return finishLoginVerification(transaction, abdmResponse, abdmAccessToken, environment, requireMobileMatch);
};

// ---------------------------------------------------------------------------
// update the ABHA's mobile number or email (needs the patient's ABHA session / X-token)
// ---------------------------------------------------------------------------

//step 1 - OTP to the NEW mobile / email
export const requestProfileContactUpdateService = async (patientId: string, facilityId: string, abdmAccessToken: string, xToken: string, environment: Environment, type: ProfileContactType, value: string, kind: AbhaTokenKind = "abha") => {
  await requireLinkedAbha(patientId, facilityId);

  if (kind === "phr") {
    throw new ApiError(422, "Verify the ABHA with its number, Aadhaar or mobile first: the mobile and email cannot be changed after an ABHA-address verification.", [], "CONTACT_UPDATE_UNAVAILABLE");
  }

  const encryptedValue = await encryptForAbdm(environment, abdmAccessToken, value);

  const abdmResponse = await requestProfileContactOtp({ accessToken: abdmAccessToken, xToken, encryptedValue, type, environment }).catch(asAbhaSessionError);

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId,
      facilityId,
      purpose: "PROFILE_UPDATE",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
    },
  });

  return { transactionId: transaction.id, message: abdmResponse.message };
};

//step 2 - verify that OTP; ABDM then holds the new value
export const verifyProfileContactUpdateService = async (patientId: string, transactionId: string, facilityId: string, abdmAccessToken: string, xToken: string, environment: Environment, otp: string, type: ProfileContactType) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "PROFILE_UPDATE");

  if (transaction.patientId !== patientId) {
    throw new ApiError(403, "Transaction does not belong to this patient");
  }

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyProfileContactOtp({ accessToken: abdmAccessToken, xToken, txnId: transaction.txnId, encryptedOtp, type, environment }).catch(asAbhaSessionError);

  if (abdmResponse.authResult && abdmResponse.authResult !== "success") {
    throw new ApiError(422, abdmResponse.message || "The OTP could not be verified. Check it and try again.", [], "OTP_INVALID");
  }

  await setTransactionStatus(transaction.id, "COMPLETED");

  return { message: abdmResponse.message ?? (type === "mobile" ? "ABHA mobile number updated" : "ABHA email updated") };
};

// Best-effort: end the patient's ABHA session at ABDM when staff sign out. Never blocks or fails the sign-out.
export const endAbhaSessionService = (abdmAccessToken: string, xToken: string, environment: Environment) => {
  void abhaLogout({ accessToken: abdmAccessToken, xToken, environment }).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// verification (link existing ABHA) - ABHA address (PHR login), OTP via Aadhaar or via the ABHA's mobile
// ---------------------------------------------------------------------------

// A bare name gets the environment's default domain: "ramesh.gupta" -> "ramesh.gupta@sbx" (sandbox) / "@abdm".
// ABDM only accepts the address in lower case ("name@SBX" is answered "Invalid ABHA Address").
const withAbhaAddressDomain = (value: string, environment: Environment) => {
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : `${trimmed}@${getCmId(environment)}`;
};

// A complete ABHA number, hyphenated; undefined when ABDM sent it masked (e.g. "91-****-****-2435") or not at all.
const fullAbhaNumber = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.includes("*")) return undefined;
  const digits = digitsOnly(value);
  return digits.length === 14 ? formatAbhaNumber(digits) : undefined;
};

export const requestAbhaAddressOtpService = async (patientId: string, facilityId: string, abdmAccessToken: string, environment: Environment, abhaAddress: string, channel: AbhaLoginChannel, consentLanguage = "en") => {
  const patient = await findPatientInFacility(patientId, facilityId);
  const address = withAbhaAddressDomain(abhaAddress, environment);

  // Find out which OTP methods this address supports before sending anything. The holder's name and number in the
  // reply are not passed on: nobody has proved who is at the desk yet.
  const found = await searchAbhaAddress({ accessToken: abdmAccessToken, abhaAddress: address, environment });

  if (found.status && found.status !== "ACTIVE") {
    throw new ApiError(422, "This ABHA address is not active, so it cannot be used.", [], "ACCOUNT_INACTIVE");
  }

  const needed = channel === "aadhaar" ? "AADHAAR_OTP" : "MOBILE_OTP";
  const methods = (found.authMethods ?? []).map((m) => String(m).toUpperCase());

  if ((found.blockedAuthMethods ?? []).map((m) => String(m).toUpperCase()).includes(needed)) {
    throw new ApiError(429, "OTP by this method is blocked for this ABHA address for now. Try the other option, or try again later.", [], "TOO_MANY_ATTEMPTS");
  }
  if (methods.length > 0 && !methods.includes(needed)) {
    throw new ApiError(
      422,
      `This ABHA address cannot receive an OTP by ${channel === "aadhaar" ? "the Aadhaar-linked mobile" : "the ABHA mobile"}. Try the other option.`,
      [],
      "OTP_CHANNEL_UNAVAILABLE",
    );
  }

  const encryptedAddress = await encryptForAbdm(environment, abdmAccessToken, address);

  const abdmResponse = await requestAbhaAddressOtp({ accessToken: abdmAccessToken, encryptedAddress, channel, environment });

  if (!abdmResponse.txnId) {
    throw new ApiError(502, "ABDM did not return a transaction ID");
  }

  const transaction = await prisma.abhaTransaction.create({
    data: {
      txnId: abdmResponse.txnId,
      patientId: patient.id,
      facilityId,
      purpose: "VERIFICATION",
      status: "PENDING",
      expiresAt: new Date(Date.now() + OTP_VALIDITY_MS),
      consentCode: HOSPITAL_LINK_CONSENT.code,
      consentVersion: HOSPITAL_LINK_CONSENT.version,
      consentAcceptedAt: new Date(),
      consentLanguage,
    },
  });

  return { transactionId: transaction.id, message: abdmResponse.message };
};

export const verifyAbhaAddressOtpService = async (transactionId: string, facilityId: string, abdmAccessToken: string, environment: Environment, otp: string, channel: AbhaLoginChannel, requireMobileMatch = false) => {
  const transaction = await loadPendingTransaction(transactionId, facilityId, "VERIFICATION");

  const encryptedOtp = await encryptForAbdm(environment, abdmAccessToken, otp);

  const abdmResponse = await verifyAbhaAddressOtp({ accessToken: abdmAccessToken, txnId: transaction.txnId, encryptedOtp, channel, environment });

  if (abdmResponse.authResult !== "success") {
    const reason = abdmResponse.message ?? "";
    if (/expired/i.test(reason)) {
      throw new ApiError(400, "This OTP is no longer valid. Request a new OTP and try again.", [], "OTP_EXPIRED");
    }
    throw new ApiError(422, reason || "The OTP could not be verified. Check it and try again.", [], "OTP_INVALID");
  }

  const users = abdmResponse.users ?? [];
  if (users.length !== 1) {
    throw new ApiError(409, "ABDM did not return exactly one ABHA for this address, so nothing was linked.", [], "MULTIPLE_ACCOUNTS");
  }
  const user = users[0]!;

  if (user.status && String(user.status).toUpperCase() !== "ACTIVE") {
    throw new ApiError(422, "This ABHA is not active, so it cannot be linked.", [], "ACCOUNT_INACTIVE");
  }

  const xToken = abdmResponse.tokens?.token ?? abdmResponse.token;
  if (!xToken) {
    throw new ApiError(502, "ABDM verified the OTP but returned no session token.");
  }
  const expiresIn = abdmResponse.tokens?.expiresIn ?? abdmResponse.expiresIn;

  const address = typeof user.abhaAddress === "string" && user.abhaAddress.trim() ? user.abhaAddress.trim() : undefined;
  if (!address) {
    throw new ApiError(502, "ABDM did not return the verified ABHA address.");
  }

  // The login reply may hold the ABHA number masked. Take it in full from the verified user, the PHR profile, or
  // (as a last resort) the address search, so the patient is linked by the same number as every other flow.
  let abhaNumber = fullAbhaNumber(user.abhaNumber);
  if (!abhaNumber) {
    const profile = await getPhrProfile({ accessToken: abdmAccessToken, xToken, environment }).catch(asAbhaSessionError);
    abhaNumber = fullAbhaNumber(profile.abhaNumber ?? profile.healthIdNumber);
  }
  if (!abhaNumber) {
    const found = await searchAbhaAddress({ accessToken: abdmAccessToken, abhaAddress: address, environment });
    abhaNumber = fullAbhaNumber(found.healthIdNumber);
  }
  if (!abhaNumber) {
    throw new ApiError(502, "ABDM did not return the full ABHA number for this address. Link with the ABHA number, Aadhaar or mobile instead.", [], "ABHA_NUMBER_UNAVAILABLE");
  }

  const demographics: AbhaDemographics = {
    name: user.fullName ?? user.name,
    dob: user.dateOfBirth ?? user.dob,
    gender: user.gender,
    mobile: user.mobile,
    address: user.address,
    stateName: user.stateName,
    districtName: user.districtName,
  };

  const abhaPatient = await linkAbhaToPatient(transaction.id, transaction.patientId, abhaNumber, address, demographics, requireMobileMatch);

  await setTransactionStatus(transaction.id, "COMPLETED");

  return {
    patientId: abhaPatient.patientId,
    detailsUpdated: abhaPatient.detailsUpdated,
    alreadyRegistered: abhaPatient.alreadyRegistered,
    transactionId: transaction.id,
    message: abdmResponse.message,
    abhaNumber: abhaPatient.abhaNumber,
    abhaAddress: abhaPatient.abhaAddress,
    mobileMatchesRecord: abhaPatient.mobileMatchesRecord,
    token: xToken,
    expiresIn,
  };
};

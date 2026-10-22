// Every backend route the frontend calls, in one place. Paths follow the backend
// README's API table; request/response shapes follow its routes and zod validators.
// If the backend changes, this is the file to update.
import { del, get, getBlob, patch, post } from '@/api/client';

export type AbdmEnvironment = 'SANDBOX' | 'PRODUCTION';

/** Language the consent text was shown in; recorded with the transaction. */
export type ConsentLanguageCode = 'en' | 'hi';

/** Facility routes answer `success: true`, the ABHA routes answer `status: 'success'`. */
interface Envelope<T> {
  message: string;
  data: T;
}

// ---- Facility (facility JWT) -------------------------------------------------

export interface FacilityInfo {
  name: string;
  email: string;
  hfrId: string;
}

export const registerFacility = (body: { name: string; email: string; hfrId: string; password: string }) =>
  post<Envelope<FacilityInfo>>('/facility/register', body);

export const loginFacility = (body: { email: string; password: string }) =>
  post<Envelope<FacilityInfo>>('/facility/login', body);

export const logoutFacility = () => post<Envelope<never>>('/facility/logout');

export const addAbdmDetails = (body: { clientId: string; clientSecret: string; environment: AbdmEnvironment }) =>
  post<Envelope<{ facilityId: string; clientId: string }>>('/facility/add-abdm-details', body);

export const createStaffAccount = (body: { name: string; email: string; password: string }) =>
  post<Envelope<{ id: string; name: string; email: string; facilityId: string }>>('/facility/create-admin', body);

// ---- Staff (user JWT) --------------------------------------------------------

/** What a staff member may do (the hospital modules' roles; logins from before the merge are administrators). */
export type StaffRole = 'front_office' | 'doctor' | 'nurse' | 'pharmacist' | 'biller' | 'housekeeping' | 'lab' | 'admin';

export interface StaffInfo {
  id: string;
  name: string;
  email: string;
  /** The hospital's name, shown in the app header */
  facilityName?: string | null;
  role: StaffRole;
  /** The person's staff record (the hospital modules' id for them). */
  staffId: string | null;
  department: string | null;
  /** A new or reset login must choose its own password before anything else. */
  mustChangePassword: boolean;
}

export const loginStaff = (body: { email: string; password: string }) =>
  post<Envelope<StaffInfo>>('/user/admin/login', body);

// The environment tells the backend which ABDM to end the patient's ABHA session on.
export const logoutStaff = (environment?: AbdmEnvironment) => post<Envelope<never>>('/user/admin/logout', { environment });

// ---- Patients (user JWT) -----------------------------------------------------

export interface BackendPatient {
  id: string;
  /** Medical record number, e.g. "MRN-10001". */
  /** Set when linking an ABHA replaced the name / date of birth typed at registration. */
  abhaUpdateNote?: string | null;
  name: string;
  phone: string;
  email: string | null;
  /** YYYY-MM-DD; checked against the ABHA before linking. Older patients may not have one. */
  dateOfBirth?: string | null;
  /** M / F / O, filled from the ABHA profile when one is linked. Fixed once verified. */
  gender?: string | null;
  address?: string | null;
  stateName?: string | null;
  districtName?: string | null;
  facilityId: string;
  createdAt: string;
}

export const createPatient = (body: { name?: string; phone?: string; email?: string; dateOfBirth?: string; gender?: 'M' | 'F' | 'O' }) =>
  post<Envelope<BackendPatient>>('/patient/create', body);

/** A patient as returned by GET /patient, with their ABHA record when linked. */
export interface BackendPatientWithAbha extends BackendPatient {
  abha?: { abhaNumber: string; abhaAddress?: string | null } | null;
}

/** Staff may edit these only. Name, date of birth and gender are fixed once verified against an ABHA. */
export const updatePatient = (
  patientId: string,
  body: { phone?: string; email?: string; address?: string; stateName?: string; districtName?: string },
) => patch<Envelope<BackendPatientWithAbha>>(`/patient/${patientId}`, body);

/** Administrators only. Removes the record, its ABHA link and OTP history here; the person's ABHA at ABDM is untouched. */
export const deletePatient = (patientId: string) => del<Envelope<never>>(`/patient/${patientId}`);

export const listPatients = () => get<Envelope<BackendPatientWithAbha[]>>('/patient');

/** ABHA transaction fields we rely on; `id` is the internal id the verify routes expect. */
export interface AbhaTransaction {
  id: string;
  txnId?: string;
  purpose?: 'ENROLLMENT' | 'VERIFICATION';
  status?: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  expiresAt?: string;
  createdAt?: string;
}

/** Newest first. */
export const listPatientTransactions = (patientId: string) =>
  get<Envelope<AbhaTransaction[]>>(`/patient/${patientId}/transactions`);

// ---- ABHA / ABDM M1 (user JWT + abdm cookies from /abha/retrieve) -------------

export const retrieveAbdmToken = (environment: AbdmEnvironment) => post<{ message: string }>('/abha/retrieve', { environment });

// `consent: true` = the patient accepted the consent text shown; the backend refuses to send an OTP without it.
export const requestAbhaCreateOtp = (body: { patientId: string; aadhaar: string; environment: AbdmEnvironment; consent: true; consentLanguage?: ConsentLanguageCode }) =>
  post<Envelope<{ txnId: string; transactionId: string }>>('/abha/create/aadhar/request', body);

export interface AbhaProfile {
  abhaNumber: string;
  abhaAddress: string | null;
  /** false when the mobile held on the ABHA differs from the hospital record; absent when ABDM sent none. */
  mobileMatchesRecord?: boolean;
  /** "name" / "date of birth": typed at registration, contradicted by the ABHA and replaced by it. */
  detailsUpdated?: string[];
  /** This ABHA already belonged to a patient here: `patientId` is that existing record. */
  alreadyRegistered?: boolean;
}

export const verifyAbhaCreateOtp = (body: {
  transactionId: string;
  otp: string;
  mobile: string;
  environment: AbdmEnvironment;
}) =>
  post<
    Envelope<
      AbhaProfile & {
        patientId: string;
        isNew: boolean;
        /** Use with the follow-up calls below (mobile verification, ABHA address). */
        transactionId: string;
        /** false when the mobile is not the Aadhaar-linked one and still has to be verified by OTP. */
        mobileVerified: boolean;
        hasFollowUp: boolean;
      }
    >
  >('/abha/create/aadhar/verify', body);

// ---- After creation: verify the mobile number, choose an ABHA address -----------------------------

export const requestEnrolMobileOtp = (body: { transactionId: string; mobile: string; environment: AbdmEnvironment }) =>
  post<Envelope<{ transactionId: string }>>('/abha/create/mobile/request', body);

export const verifyEnrolMobileOtp = (body: { transactionId: string; otp: string; environment: AbdmEnvironment }) =>
  post<Envelope<{ transactionId: string }>>('/abha/create/mobile/verify', body);

export const getAbhaAddressSuggestions = (transactionId: string, environment: AbdmEnvironment) =>
  get<Envelope<{ suggestions: string[] }>>(`/abha/create/address/suggestions?transactionId=${encodeURIComponent(transactionId)}&environment=${environment}`);

export const createAbhaAddress = (body: { transactionId: string; abhaAddress: string; environment: AbdmEnvironment }) =>
  post<Envelope<{ abhaAddress: string }>>('/abha/create/address', body);

export const requestAbhaLinkOtp = (body: { patientId: string; aadhaar: string; environment: AbdmEnvironment; consent: true; consentLanguage?: ConsentLanguageCode }) =>
  post<Envelope<{ transactionId: string }>>('/abha/verify/aadhar/request', body);

export const confirmAbhaLink = (body: { transactionId: string; otp: string; environment: AbdmEnvironment }) =>
  post<Envelope<AbhaProfile & { patientId: string; transactionId: string }>>('/abha/verify/aadhar/confirm', body);

// ABHA number flow: the OTP goes to the Aadhaar-linked mobile or to the mobile registered with the ABHA
export type AbhaLoginChannel = 'aadhaar' | 'mobile';

export const requestAbhaNumberOtp = (body: {
  patientId: string;
  abhaNumber: string;
  channel: AbhaLoginChannel;
  environment: AbdmEnvironment;
  consent: true;
  consentLanguage?: ConsentLanguageCode;
}) => post<Envelope<{ transactionId: string }>>('/abha/verify/number/request', body);

export const confirmAbhaNumberOtp = (body: {
  transactionId: string;
  otp: string;
  channel: AbhaLoginChannel;
  environment: AbdmEnvironment;
  /** the patient was registered with this ABHA and a mobile number, which must be the ABHA's own */
  requireMobileMatch?: boolean;
}) => post<Envelope<AbhaProfile & { patientId: string; transactionId: string }>>('/abha/verify/number/confirm', body);

// ABHA address flow (PHR login): same two OTP channels as the ABHA number flow
export const requestAbhaAddressOtp = (body: {
  patientId: string;
  abhaAddress: string;
  channel: AbhaLoginChannel;
  environment: AbdmEnvironment;
  consent: true;
  consentLanguage?: ConsentLanguageCode;
}) => post<Envelope<{ transactionId: string }>>('/abha/verify/address/request', body);

export const confirmAbhaAddressOtp = (body: {
  transactionId: string;
  otp: string;
  channel: AbhaLoginChannel;
  environment: AbdmEnvironment;
  requireMobileMatch?: boolean;
}) => post<Envelope<AbhaProfile & { patientId: string; transactionId: string }>>('/abha/verify/address/confirm', body);

// Mobile verification flow (Step 1, Step 2, Step 3)
export const requestAbhaMobileOtp = (body: { patientId: string; mobile: string; environment: AbdmEnvironment; consent: true; consentLanguage?: ConsentLanguageCode }) =>
  post<Envelope<{ transactionId: string; txnId: string }>>('/abha/verify/mobile/request', body);

export interface AbhaAccountItem {
  ABHANumber: string;
  preferredAbhaAddress?: string;
  name?: string;
  gender?: string;
  dob?: string;
  status?: string;
  [key: string]: unknown;
}

export const confirmAbhaMobileOtp = (body: { transactionId: string; otp: string; environment: AbdmEnvironment }) =>
  post<Envelope<{ transactionId: string; txnId: string; token: string; accounts: AbhaAccountItem[]; matchedAbhaNumbers?: string[] }>>('/abha/verify/mobile/confirm', body);

export const verifyAbhaMobileUser = (body: { abhaNumber: string; transactionId: string; environment: AbdmEnvironment }) =>
  post<Envelope<{
    patientId: string;
    transactionId: string;
    detailsUpdated?: string[];
    alreadyRegistered?: boolean;
    abhaNumber: string;
    abhaAddress: string | null;
    name?: string;
    gender?: string;
    dob?: string;
    kycVerified?: boolean;
    mobileMatchesRecord?: boolean;
  }>>('/abha/verify/mobile/user', body);

// ABHA profile and live QR code
export interface FullAbhaProfile {
  ABHANumber?: string;
  preferredAbhaAddress?: string;
  name?: string;
  gender?: string;
  dob?: string;
  address?: string;
  kycVerified?: boolean;
  [key: string]: unknown;
}

// Both are tied to the patient whose ABHA was last verified in this browser session.
export const getAbhaProfile = (patientId: string, environment: AbdmEnvironment = 'SANDBOX') =>
  get<Envelope<FullAbhaProfile>>(`/abha/profile?patientId=${encodeURIComponent(patientId)}&environment=${environment}`);

export const getAbhaQrCodeBlob = (patientId: string, environment: AbdmEnvironment = 'SANDBOX') =>
  getBlob(`/abha/profile/qr?patientId=${encodeURIComponent(patientId)}&environment=${environment}`);


export const getAbhaCardBlob = (patientId: string, environment: AbdmEnvironment = 'SANDBOX') =>
  getBlob(`/abha/profile/card?patientId=${encodeURIComponent(patientId)}&environment=${environment}`);

// ---- Dashboard counts ----------------------------------------------------------------------------------------

export interface DashboardData {
  totalPatients: number;
  abhaLinked: number;
  withoutAbha: number;
  registeredToday: number;
  pendingShares: number;
  recentActivity: { id: string; action: string; outcome: 'SUCCESS' | 'FAILURE'; errorCode: string | null; createdAt: string }[];
}

export const getDashboard = () => get<Envelope<DashboardData>>('/dashboard');

// ---- Scan & Share: profiles patients shared by scanning a counter QR code ---------------------------------------

export interface SharedProfile {
  id: string;
  counterCode: string;
  tokenNumber: number;
  name: string;
  gender: string | null;
  dayOfBirth: number | null;
  monthOfBirth: number | null;
  yearOfBirth: number;
  abhaNumber: string | null;
  abhaAddress: string;
  phone: string | null;
  address: string | null;
  receivedAt: string;
  /** The token (and so this entry) stops being valid at this time. */
  expiresAt: string;
  /** Set when this ABHA is already linked to a patient here. */
  matchedPatient: { id: string; name: string } | null;
}

export const listSharedProfiles = () => get<Envelope<SharedProfile[]>>('/abha/shares');

export const getShareConfig = (environment: AbdmEnvironment) =>
  get<Envelope<{ hipId: string; qrBaseUrl: string; validityMinutes: number }>>(`/abha/shares/config?environment=${environment}`);

/** `phone` is only needed when the shared profile has no usable mobile number. */
export const registerSharedProfile = (shareId: string, body: { phone?: string } = {}) =>
  post<Envelope<{ patientId: string; created: boolean; abhaLinked: boolean }>>(`/abha/shares/${shareId}/register`, body);

export const dismissSharedProfile = (shareId: string) => post<Envelope<never>>(`/abha/shares/${shareId}/dismiss`);

// ---- Update the mobile number / email held on the ABHA (OTP goes to the new value) --------------------------------

export const requestAbhaContactUpdate = (
  body:
    | { patientId: string; type: 'mobile'; value: string; environment: AbdmEnvironment }
    | { patientId: string; type: 'email'; value: string; environment: AbdmEnvironment },
) => post<Envelope<{ transactionId: string }>>('/abha/profile/contact/request', body);

export const verifyAbhaContactUpdate = (body: {
  patientId: string;
  transactionId: string;
  otp: string;
  type: 'mobile' | 'email';
  environment: AbdmEnvironment;
}) => post<Envelope<{ patientId: string }>>('/abha/profile/contact/verify', body);

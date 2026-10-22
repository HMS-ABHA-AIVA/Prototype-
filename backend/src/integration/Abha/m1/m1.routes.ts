import express from "express";
import {aadhaarOtpRequestController, aadhaarOtpVerifyController, abdmTokenRetrievalRequest, generateAbhaQrController, getAbhaProfileController, getAbhaCardController, requestExistingAbhaAadhaarOtpController, requestExistingAbhaMobileOtpController, verifyExistingAbhaAadhaarOtpController, verifyExistingAbhaMobileOtpController, verifyExistingAbhaMobileUserController, enrolMobileRequestController, enrolMobileVerifyController, abhaAddressSuggestionsController, createAbhaAddressController, abhaNumberOtpRequestController, abhaNumberOtpVerifyController, listAbhaAuditController, profileContactRequestController, profileContactVerifyController, abhaAddressOtpRequestController, abhaAddressOtpVerifyController} from "./m1.controller.js";
import {verifyUserJwt} from "../../../common/middlewares/verifyUserJwt.js"
import {rateLimit} from "../../../common/middlewares/rateLimit.middleware.js"
import {auditAbha} from "../../../common/middlewares/auditAbha.middleware.js"

const abdmRouter = express.Router();

// OTP abuse protection: 10 requests/minute per IP per route
const otpLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Every action below is written to the ABHA audit trail (who, what, outcome) by auditAbha.
abdmRouter.post("/retrieve",verifyUserJwt, auditAbha("ABDM_SESSION"), abdmTokenRetrievalRequest);

// CREATE ABHA (Aadhaar)
abdmRouter.post("/create/aadhar/request",otpLimiter,verifyUserJwt,auditAbha("CREATE_AADHAAR_OTP_REQUEST"),aadhaarOtpRequestController);
abdmRouter.post("/create/aadhar/verify",otpLimiter,verifyUserJwt,auditAbha("CREATE_AADHAAR_OTP_VERIFY"),aadhaarOtpVerifyController);

// ...then, optionally: verify the communication mobile and choose an ABHA address
abdmRouter.post("/create/mobile/request",otpLimiter,verifyUserJwt,auditAbha("CREATE_MOBILE_OTP_REQUEST"),enrolMobileRequestController);
abdmRouter.post("/create/mobile/verify",otpLimiter,verifyUserJwt,auditAbha("CREATE_MOBILE_OTP_VERIFY"),enrolMobileVerifyController);
abdmRouter.get("/create/address/suggestions",verifyUserJwt,auditAbha("ABHA_ADDRESS_SUGGESTIONS"),abhaAddressSuggestionsController);
abdmRouter.post("/create/address",verifyUserJwt,auditAbha("ABHA_ADDRESS_CREATE"),createAbhaAddressController);


// EXISTING ABHA VERIFICATION

//aadhar number verification
abdmRouter.post("/verify/aadhar/request",otpLimiter,verifyUserJwt,auditAbha("LINK_AADHAAR_OTP_REQUEST"),requestExistingAbhaAadhaarOtpController);
abdmRouter.post("/verify/aadhar/confirm",otpLimiter,verifyUserJwt,auditAbha("LINK_AADHAAR_OTP_VERIFY"),verifyExistingAbhaAadhaarOtpController);

//mobile number verification
abdmRouter.post("/verify/mobile/request",otpLimiter,verifyUserJwt,auditAbha("LINK_MOBILE_OTP_REQUEST"),requestExistingAbhaMobileOtpController);
abdmRouter.post("/verify/mobile/confirm",otpLimiter,verifyUserJwt,auditAbha("LINK_MOBILE_OTP_VERIFY"),verifyExistingAbhaMobileOtpController);
abdmRouter.post("/verify/mobile/user",otpLimiter,verifyUserJwt,auditAbha("LINK_MOBILE_SELECT_ACCOUNT"),verifyExistingAbhaMobileUserController);

//ABHA number verification (OTP to the Aadhaar-linked mobile or to the ABHA's mobile)
abdmRouter.post("/verify/number/request",otpLimiter,verifyUserJwt,auditAbha("LINK_ABHA_NUMBER_OTP_REQUEST"),abhaNumberOtpRequestController);
abdmRouter.post("/verify/number/confirm",otpLimiter,verifyUserJwt,auditAbha("LINK_ABHA_NUMBER_OTP_VERIFY"),abhaNumberOtpVerifyController);

//ABHA address verification (PHR login; OTP to the Aadhaar-linked mobile or to the ABHA's mobile)
abdmRouter.post("/verify/address/request",otpLimiter,verifyUserJwt,auditAbha("LINK_ABHA_ADDRESS_OTP_REQUEST"),abhaAddressOtpRequestController);
abdmRouter.post("/verify/address/confirm",otpLimiter,verifyUserJwt,auditAbha("LINK_ABHA_ADDRESS_OTP_VERIFY"),abhaAddressOtpVerifyController);

//generate ABHA QR code
abdmRouter.get("/profile/qr",verifyUserJwt,auditAbha("ABHA_QR_VIEW"),generateAbhaQrController);
//download ABHA card
abdmRouter.get("/profile/card",verifyUserJwt,auditAbha("ABHA_CARD_DOWNLOAD"),getAbhaCardController);
//get ABHA profile
abdmRouter.get("/profile",verifyUserJwt,auditAbha("ABHA_PROFILE_VIEW"),getAbhaProfileController);

//update the ABHA's mobile number / email: OTP to the new value, then verify
abdmRouter.post("/profile/contact/request",otpLimiter,verifyUserJwt,auditAbha("ABHA_CONTACT_UPDATE_OTP_REQUEST"),profileContactRequestController);
abdmRouter.post("/profile/contact/verify",otpLimiter,verifyUserJwt,auditAbha("ABHA_CONTACT_UPDATE_OTP_VERIFY"),profileContactVerifyController);

//audit trail
abdmRouter.get("/audit",verifyUserJwt,listAbhaAuditController);
export default abdmRouter;

// ABDM words its OTP confirmation like "OTP sent to Aadhaar registered mobile number ending with ******6375".
// NHA's sheet (CRT_ABHA_105) wants the staff-facing text to read like
// "We just sent an OTP on the Mobile Number *******6375 linked with Aadhaar. Enter the OTP below to proceed with ABHA creation."
// The number stays masked: we only ever show what ABDM already masked.

const maskedFrom = (abdmMessage: string): string | undefined => abdmMessage.match(/\*{2,}\s?\d{3,4}/)?.[0]?.replace(/\s/g, "");

export function formatOtpMessage(
  mode: "create_aadhaar" | "link_aadhaar" | "link_mobile" | "link_number" | "link_address",
  abdmMessage: string,
  channel?: "aadhaar" | "mobile",
): string {
  const masked = maskedFrom(abdmMessage);
  if (!masked) return abdmMessage;

  if (mode === "create_aadhaar") {
    return `We just sent an OTP on the Mobile Number ${masked} linked with Aadhaar. Enter the OTP below to proceed with ABHA creation.`;
  }
  if (mode === "link_aadhaar" || ((mode === "link_number" || mode === "link_address") && channel === "aadhaar")) {
    return `We just sent an OTP on the Mobile Number ${masked} linked with Aadhaar. Enter the OTP below to verify the ABHA.`;
  }
  return `We just sent an OTP on the Mobile Number ${masked} registered with the ABHA. Enter the OTP below to continue.`;
}

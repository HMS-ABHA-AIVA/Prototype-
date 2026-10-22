// Rules from NHA's M1 assessment sheet, kept in one place so every screen follows them.

/** Resend OTP: available only after 60 seconds, and at most twice per OTP request. */
export const OTP_RESEND_SECONDS = 60;
export const MAX_OTP_RESENDS = 2;

/** Policy printed beside the ABHA address field (NHA test case CRT_ABHA_112). */
export const ABHA_ADDRESS_POLICY = [
  "8 to 18 characters",
  "Letters and numbers only, apart from one dot (.) and/or one underscore (_)",
  "A dot or underscore must be in the middle, never at the start or the end",
];

export const isValidAbhaAddressName = (value: string): boolean =>
  /^(?=.{8,18}$)[a-z0-9]+([._][a-z0-9]+)*$/i.test(value) &&
  (value.match(/\./g)?.length ?? 0) <= 1 &&
  (value.match(/_/g)?.length ?? 0) <= 1;

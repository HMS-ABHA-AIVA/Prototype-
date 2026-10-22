import { z } from "zod";

/**
 * Says exactly what is wrong with a mobile number, or returns null when it is fine.
 * Mirrors frontend/src/lib/mobile.ts so the screen and the API give the same answer.
 */
export const mobileProblem = (raw: string): string | null => {
  const value = raw.trim();
  if (value === "") return "Enter the 10-digit mobile number.";

  const stray = [...new Set(value.replace(/\d/g, "").replace(/\s/g, ""))];
  if (stray.length > 0) {
    return `The mobile number can contain digits only, but it has ${stray.map((c) => `"${c}"`).join(" ")}. Do not type +91, dashes or spaces.`;
  }
  if (/\s/.test(value)) return "The mobile number has a space in it. Type the 10 digits together.";

  if (value.length < 10) return `The mobile number has ${value.length} digit${value.length === 1 ? "" : "s"}, but it needs 10.`;
  if (value.length > 10) {
    if (value.length === 12 && value.startsWith("91")) return "The mobile number has 12 digits. Leave out the country code 91 and type just the 10 digits.";
    if (value.length === 11 && value.startsWith("0")) return "The mobile number has 11 digits. Leave out the leading 0 and type just the 10 digits.";
    return `The mobile number has ${value.length} digits, but it needs exactly 10.`;
  }
  if (!/^[6-9]/.test(value)) return `The mobile number starts with ${value[0]}, but Indian mobile numbers start with 6, 7, 8 or 9.`;
  if (/^(\d)\1{9}$/.test(value)) return "The mobile number is the same digit repeated ten times, which is not a real number.";
  return null;
};

/** A 10-digit Indian mobile number, with a message that names the actual problem. */
export const mobileNumber = z.string().superRefine((value, ctx) => {
  const problem = mobileProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

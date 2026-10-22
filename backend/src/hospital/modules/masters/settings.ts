import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { actorOf } from "../../shared/http.js";
import { parse } from "../../shared/validate.js";

/**
 * The hospital's own billing and print settings. Only values the hospital has changed are stored (HospitalSetting); anything
 * not set falls back to the default here.
 */
export const DEFAULT_CONSENT_TEXT =
  "I, the patient / the patient's representative named above, consent to the admission, examination, investigations and treatment advised by " +
  "the treating doctors of this hospital. The nature of the illness, the proposed treatment and its usual risks and alternatives have been " +
  "explained to me in a language I understand, and I have had the chance to ask questions. I understand that I may withdraw this consent for " +
  "any treatment that has not yet been given. I will pay the hospital's charges as per the tariff, and I have been told that the estimate may " +
  "change as my condition requires. I have given correct information about the patient's identity and medical history.";

export interface Settings {
  /** Fee for a doctor who has no fee of their own. */
  opdDefaultFee: number;
  /** Emergency consultation and triage fee. */
  erFee: number;
  /** What a test ordered as free text (not in the test master) is charged. */
  unlistedTestPrice: number;
  /** What a dispensed medicine that is not in the stock list is charged per unit (an MRP: it includes the GST below). */
  unlistedMedicinePrice: number;
  /** GST on a medicine that is not in the stock list. */
  medicineGstPct: number;
  /** A bed day ends at this hour (0-23): staying past it on a later date charges another day. */
  bedDayCheckoutHour: number;
  /** The hospital's GSTIN, printed on invoices. */
  gstin: string;
  /** Hospital registration number (clinical establishment / state registration), printed on forms. */
  registrationNo: string;
  /** The pharmacy's drug licence number, printed on its invoices. */
  drugLicenseNo: string;
  /** When on, a lab or radiology report must be signed by someone other than the person who entered the results. */
  requireReportVerification: boolean;
  /** Wording of the consent on the admission form. */
  consentText: string;
  /** Line printed at the foot of invoices and receipts. */
  billFooter: string;
}

export const SETTING_DEFAULTS: Settings = {
  opdDefaultFee: 600,
  erFee: 900,
  unlistedTestPrice: 450,
  unlistedMedicinePrice: 120,
  medicineGstPct: 12,
  bedDayCheckoutHour: 12,
  gstin: "",
  registrationNo: "",
  drugLicenseNo: "",
  requireReportVerification: false,
  consentText: DEFAULT_CONSENT_TEXT,
  billFooter: "This is a computer generated document.",
};

export const SETTING_KEYS: Record<keyof Settings, string> = {
  opdDefaultFee: "opd_default_fee",
  erFee: "er_fee",
  unlistedTestPrice: "unlisted_test_price",
  unlistedMedicinePrice: "unlisted_medicine_price",
  medicineGstPct: "medicine_gst_pct",
  bedDayCheckoutHour: "bed_day_checkout_hour",
  gstin: "gstin",
  registrationNo: "registration_no",
  drugLicenseNo: "drug_license_no",
  requireReportVerification: "require_report_verification",
  consentText: "consent_text",
  billFooter: "bill_footer",
};

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const updateSchema = z
  .object({
    opdDefaultFee: z.number().min(0).max(1_000_000),
    erFee: z.number().min(0).max(1_000_000),
    unlistedTestPrice: z.number().min(0).max(1_000_000),
    unlistedMedicinePrice: z.number().min(0).max(1_000_000),
    medicineGstPct: z.number().min(0).max(100),
    bedDayCheckoutHour: z.number().int().min(0).max(23),
    gstin: z.string().trim().toUpperCase().refine((v) => v === "" || GSTIN.test(v), "A GSTIN is 15 characters, e.g. 27ABCDE1234F1Z5"),
    registrationNo: z.string().trim().max(60),
    drugLicenseNo: z.string().trim().max(60),
    requireReportVerification: z.boolean(),
    consentText: z.string().trim().min(20).max(4000),
    billFooter: z.string().trim().max(200),
  })
  .partial();

export async function getSettings(db: Queryable): Promise<Settings> {
  const rows = await db.query<{ key: string; value: string }>('SELECT key, value FROM "HospitalSetting" WHERE "facilityId" = :fid');
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const settings: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const [name, key] of Object.entries(SETTING_KEYS)) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    const kind = typeof SETTING_DEFAULTS[name as keyof Settings];
    settings[name] = kind === "number" ? Number(raw) : kind === "boolean" ? raw === "true" : raw;
  }
  return settings as unknown as Settings;
}

/** Stores one setting for the hospital in scope (used by the settings screen and the demo data). */
export async function putSetting(db: Queryable, name: keyof Settings, value: string | number | boolean): Promise<void> {
  await db.execute(
    `INSERT INTO "HospitalSetting" ("facilityId", key, value) VALUES (:fid, $1, $2)
     ON CONFLICT ("facilityId", key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
    [SETTING_KEYS[name], String(value)],
  );
}

export function settingsRouter({ db }: HospitalContext): Router {
  const router = Router();

  // Anyone signed in may read them (screens and printouts use the hospital's GSTIN, footer and so on).
  router.get("/", async (_req, res) => {
    res.json(await getSettings(db));
  });

  router.put("/", requireRole("admin"), async (req, res) => {
    const change = parse(updateSchema, req.body);
    const names = Object.keys(change) as (keyof Settings)[];
    await db.transaction(async (tx) => {
      for (const name of names) await putSetting(tx, name, change[name]!);
      if (names.length) await recordAudit(tx, actorOf(req), "Hospital Settings Updated", names.join(", "));
    });
    res.json(await getSettings(db));
  });

  return router;
}

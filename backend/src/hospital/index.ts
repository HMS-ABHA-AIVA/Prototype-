import { Router, type ErrorRequestHandler, type Request } from "express";
import { ApiError } from "../common/errors/appError.js";
import { logSecurityEvent } from "../common/utils/securityLog.js";
import { authRouter } from "./auth/auth.routes.js";
import { requireRole, requireStaff } from "./auth/session.js";
import { loadHospitalEnv, type HospitalEnv } from "./config.js";
import type { HospitalContext } from "./context.js";
import { createDatabase, NoFacilityScopeError, type Database } from "./db.js";
import { aiRouter } from "./modules/ai/ai.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { bedsRouter } from "./modules/beds/beds.routes.js";
import { billingRouter } from "./modules/billing/billing.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.js";
import { loadDrugCatalog } from "./modules/drugs/drug-catalog.js";
import { DrugLookup } from "./modules/drugs/drug-lookup.js";
import { DrugOnline } from "./modules/drugs/drug-online.js";
import { drugsRouter } from "./modules/drugs/drugs.routes.js";
import { encountersRouter } from "./modules/encounters/encounters.routes.js";
import { facilityRouter } from "./modules/facility/facility.js";
import { mastersRouter } from "./modules/masters/masters.routes.js";
import { createSmsProvider, messagingRouter, OtpService } from "./modules/messaging/messaging.js";
import { opdBillingRouter } from "./modules/opd-billing/opd-billing.js";
import { panelsRouter } from "./modules/panels/panels.js";
import { patientsRouter } from "./modules/patients/patients.routes.js";
import { staffRouter } from "./modules/staff/staff.js";
import { createFileStore } from "./modules/storage/file-store.js";
import { ipdBillingRouter } from "./modules/ipd/ipd-billing.routes.js";
import { ipdRouter } from "./modules/ipd/ipd.routes.js";
import { labRouter } from "./modules/lab/lab.js";
import { payrollRouter } from "./modules/payroll/payroll.routes.js";
import { pharmacyRouter } from "./modules/pharmacy/pharmacy.js";
import { wardMedicineRouter } from "./modules/pharmacy/ward-medicine.js";
import { bootstrapPlatformAdmin, platformRouter } from "./modules/platform/platform.js";
import { rosterRouter } from "./modules/roster/roster.js";
import { suppliesRouter } from "./modules/supplies/supplies.js";
import { wasteRouter } from "./modules/waste/waste.js";
import { AppError, forbidden } from "./shared/errors.js";
import { createLogger } from "./shared/logger.js";

/**
 * The hospital modules merged from AIVA OSHealth, served under /api/v1 (same paths and JSON as OSHealth, so its screens work as
 * they are). Sign-in is the application's own (POST /api/user/admin/login); every route here runs inside the signed-in staff
 * member's hospital, and each area is limited to the roles that work in it (finer rules sit next to the route they protect).
 */
export interface HospitalApi {
  router: Router;
  ctx: HospitalContext;
  /** First-run work at startup (the platform administrator from the environment). */
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createHospitalApi(options: { databaseUrl?: string; env?: HospitalEnv; db?: Database } = {}): HospitalApi {
  const env = options.env ?? loadHospitalEnv();
  const log = createLogger(env.logLevel);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.db && !databaseUrl) throw new Error("DATABASE_URL is not configured");
  const db = options.db ?? createDatabase(databaseUrl!);
  const files = createFileStore({ kind: env.fileStore, dir: env.fileStoreDir, nodeEnv: env.nodeEnv });
  if (files.kind === "none" && env.nodeEnv === "production") log.warn("No document storage is configured (FILE_STORE): documents cannot be attached.");
  const sms = createSmsProvider(env.smsProvider);
  const ctx: HospitalContext = { env, db, log, files, sms, otp: new OtpService(sms), drugs: new DrugLookup(db, new DrugOnline(env, log)) };
  // Warm the Indian brand list in the background so the first search is quick; searches wait for it if they come sooner.
  if (env.nodeEnv !== "test") {
    loadDrugCatalog().then(
      (catalog) => log.info(`Drug list ready: ${catalog.size} Indian brands`),
      (error: unknown) => log.warn("Drug list could not be loaded", { message: error instanceof Error ? error.message : String(error) }),
    );
  }

  const api = Router();
  api.use("/auth", authRouter(ctx)); // who am I, change password, forgot password
  api.use("/platform", platformRouter(ctx)); // the people who run the product: own sign-in and token, never a hospital's data

  // Everything below needs a signed-in staff member, inside their own hospital.
  api.use(requireStaff(db));
  api.use("/facility", facilityRouter(ctx));
  api.use("/staff", staffRouter(ctx));
  // The lab looks patients up (to raise a lab-desk invoice and to read their reports) but registering and editing is the front office's work.
  api.use(
    "/patients",
    requireRole("front_office", "doctor", "nurse", "pharmacist", "biller", "lab", "admin"),
    (req, _res, next) => next(req.staff?.role === "lab" && req.method !== "GET" ? forbidden() : undefined),
    patientsRouter(ctx),
  );
  api.use("/encounters", requireRole("front_office", "doctor", "nurse", "admin"), encountersRouter(ctx));
  api.use("/beds", requireRole("front_office", "doctor", "nurse", "housekeeping", "admin"), bedsRouter(ctx));
  api.use("/pharmacy", requireRole("pharmacist", "doctor", "nurse", "admin"), pharmacyRouter(ctx));
  api.use("/lab", labRouter(ctx)); // lab and radiology: worklist, results, signed reports, desk invoices, MIS (roles are set per route)
  api.use("/ward-medicine", wardMedicineRouter(ctx)); // the nurse's medicine round (roles are set per route)
  api.use("/ai", aiRouter(ctx)); // any signed-in staff member may ask whether the AI is on
  api.use("/drugs", requireRole("doctor", "nurse", "pharmacist", "admin"), drugsRouter(ctx));
  api.use("/bills", requireRole("biller", "admin"), billingRouter(ctx));
  api.use("/opd-billing", requireRole("front_office", "biller", "admin"), opdBillingRouter(ctx)); // OPD invoices: registration, billing, then the queue
  api.use("/masters", mastersRouter(ctx)); // hospital settings, services, wards, tests, panel rates, prescription templates
  api.use("/ipd-billing", requireRole("front_office", "doctor", "nurse", "biller", "admin"), ipdBillingRouter(ctx)); // running bill, charges, advances, final bill
  api.use("/ipd", ipdRouter(ctx)); // births and attached documents (roles are set per route)
  api.use("/messages", messagingRouter(ctx)); // administrators: what the SMS simulator "sent"
  api.use("/panels", panelsRouter(ctx)); // CGHS, DGHS ... special rates (read: front office, biller, admin; edit: admin)
  api.use("/supplies", requireRole("front_office", "nurse", "admin"), suppliesRouter(ctx));
  api.use("/waste", requireRole("front_office", "nurse", "housekeeping", "admin"), wasteRouter(ctx));
  api.use("/roster", rosterRouter(ctx)); // everyone may view; planners edit
  api.use("/payroll", payrollRouter(ctx)); // attendance + payroll: administrators only
  api.use("/dashboard", dashboardRouter(ctx));
  api.use("/audit-log", requireRole("admin"), auditRouter(ctx));

  const router = Router();
  router.use(api);
  router.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.baseUrl}${req.path}` } });
  });
  router.use(errorHandler(ctx));

  return { router, ctx, start: () => bootstrapPlatformAdmin(ctx), close: () => db.close() };
}

// Failures NDHM asks to be logged (authentication, access control, validation, rate limits), as in the rest of the application.
function securityEventFor(status: number, code: string): string | undefined {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if (code === "VALIDATION_ERROR") return "INPUT_REJECTED";
  return undefined;
}

/** Turns any thrown error into the standard { error: { code, message, details? } } response of /api/v1. */
function errorHandler({ log }: HospitalContext): ErrorRequestHandler {
  return (error, req: Request, res, next) => {
    if (res.headersSent) return next(error);

    const send = (status: number, code: string, message: string, details?: unknown) => {
      const event = securityEventFor(status, code);
      if (event) logSecurityEvent(event, req, { status, code });
      res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
    };

    if (error instanceof AppError) return send(error.status, error.code, error.message, error.details);
    // Shared middleware of the application (rate limits, CSRF guard) reports with its own error class.
    if (error instanceof ApiError) return send(error.statusCode, error.code ?? (error.statusCode === 429 ? "RATE_LIMITED" : "ERROR"), error.message);

    // Malformed request bodies (body-parser)
    if (error?.type === "entity.parse.failed") return send(400, "INVALID_JSON", "The request body is not valid JSON");
    if (error?.type === "entity.too.large") return send(413, "PAYLOAD_TOO_LARGE", "The request body is too large");

    // Database constraint violations that slipped past validation
    switch (error?.code) {
      case "23505":
        return send(409, "CONFLICT", "That record already exists");
      case "23503":
        return send(409, "CONFLICT", "A related record is missing or still in use");
      case "23514":
      case "22P02":
        return send(400, "BAD_REQUEST", "A value is outside the allowed range or format");
    }

    if (error instanceof NoFacilityScopeError) log.error("hospital data requested outside a hospital scope", { path: req.path });
    else log.error("unhandled error", { message: error?.message, stack: error?.stack });
    logSecurityEvent("SYSTEM_ERROR", req, { status: 500 });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side" } });
  };
}

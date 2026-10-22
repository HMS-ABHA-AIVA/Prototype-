import { resolve } from "node:path";

/**
 * Settings of the hospital modules (src/hospital), read from environment variables in one typed place. The database,
 * sign-in secrets, CORS and ABDM settings are the application's own (backend/.env.example); these are the additions
 * merged from AIVA OSHealth.
 */
export interface HospitalEnv {
  nodeEnv: "development" | "test" | "production";
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  /** Where attached documents are kept (FILE_STORE: auto | local | memory | none; FILE_STORE_DIR for local). See docs/HOSPITAL_MODULES.md. */
  fileStore: "auto" | "local" | "memory" | "none";
  fileStoreDir: string;
  /** Who sends text messages and OTPs (SMS_PROVIDER). Only the built-in simulator exists for now. */
  smsProvider: string;
  /** The doctor's AI assistant and AI-drafted discharge summaries (ANTHROPIC_API_KEY). Off when empty: no patient data leaves the system. */
  anthropicApiKey?: string;
  /** 'anthropic' (Claude, the default) or 'gemini' (free tier for DEMOS with invented patients only). */
  aiProvider: "anthropic" | "gemini";
  geminiApiKey?: string;
  /** AI_PAID_TIER=true once the Gemini key belongs to a billing-enabled Google project. */
  aiPaidTier: boolean;
  aiModel: string;
  aiBaseUrl: string;
  aiReasoningEffort: string;
  /** Throttles sign-in, AI and other sensitive routes. Turned off in tests. */
  rateLimitEnabled: boolean;
  /** Drug search may also ask the free US RxNorm services (only the typed drug text is sent). DRUG_ONLINE_LOOKUP=false stops it. */
  drugOnlineLookup: boolean;
  rxnavUrl: string;
  clinicalTablesUrl: string;
  /** Creates the first platform administrator at startup (PLATFORM_ADMIN_USERNAME / PLATFORM_ADMIN_PASSWORD). */
  platformAdmin?: { username: string; password: string };
  /** Secret for platform-console tokens; derived from USER_ACCESS_TOKEN_SECRET (never the same key). */
  platformTokenHours: number;
}

export function loadHospitalEnv(source: Record<string, string | undefined> = process.env): HospitalEnv {
  const nodeEnv = (["development", "test", "production"].includes(source.NODE_ENV ?? "") ? source.NODE_ENV : "development") as HospitalEnv["nodeEnv"];
  const flag = (name: string, fallback: boolean) => (source[name] === undefined ? fallback : source[name] === "true");
  const requested = source.AI_PROVIDER?.trim().toLowerCase();
  const aiProvider: HospitalEnv["aiProvider"] =
    requested === "gemini" || requested === "anthropic"
      ? requested
      : source.GEMINI_API_KEY?.trim() && !source.ANTHROPIC_API_KEY?.trim() ? "gemini" : "anthropic";
  const anthropicApiKey = source.ANTHROPIC_API_KEY?.trim() || undefined;
  const geminiApiKey = source.GEMINI_API_KEY?.trim() || undefined;

  return {
    nodeEnv,
    logLevel: (source.LOG_LEVEL as HospitalEnv["logLevel"]) || (nodeEnv === "test" ? "silent" : "info"),
    fileStore: (["auto", "local", "memory", "none"].includes(source.FILE_STORE ?? "") ? source.FILE_STORE : "auto") as HospitalEnv["fileStore"],
    fileStoreDir: resolve(source.FILE_STORE_DIR || "./data/files"),
    smsProvider: (source.SMS_PROVIDER || "simulator").trim().toLowerCase(),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(geminiApiKey ? { geminiApiKey } : {}),
    aiProvider,
    aiPaidTier: flag("AI_PAID_TIER", false),
    aiModel: source.AI_MODEL?.trim() || (aiProvider === "gemini" ? "gemini-3.5-flash" : "claude-sonnet-5-5"),
    aiBaseUrl: source.AI_API_URL?.trim() || (aiProvider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://api.anthropic.com"),
    aiReasoningEffort: source.AI_REASONING_EFFORT === undefined ? "low" : source.AI_REASONING_EFFORT.trim(),
    // As for the rest of the API (rateLimit.middleware.ts): the limits can be switched off only outside production.
    rateLimitEnabled: nodeEnv === "production" || flag("RATE_LIMIT_ENABLED", nodeEnv !== "test"),
    drugOnlineLookup: flag("DRUG_ONLINE_LOOKUP", nodeEnv !== "test"),
    rxnavUrl: (source.RXNAV_URL?.trim() || "https://rxnav.nlm.nih.gov").replace(/\/+$/, ""),
    clinicalTablesUrl: (source.CLINICAL_TABLES_URL?.trim() || "https://clinicaltables.nlm.nih.gov").replace(/\/+$/, ""),
    ...(source.PLATFORM_ADMIN_PASSWORD
      ? { platformAdmin: { username: (source.PLATFORM_ADMIN_USERNAME || "platform").trim().toLowerCase(), password: source.PLATFORM_ADMIN_PASSWORD } }
      : {}),
    platformTokenHours: Number(source.PLATFORM_TOKEN_HOURS) || 8,
  };
}

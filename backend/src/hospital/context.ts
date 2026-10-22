import type { HospitalEnv } from "./config.js";
import type { Database } from "./db.js";
import type { DrugLookup } from "./modules/drugs/drug-lookup.js";
import type { OtpService, SmsProvider } from "./modules/messaging/messaging.js";
import type { FileStore } from "./modules/storage/file-store.js";
import type { Logger } from "./shared/logger.js";

/**
 * The shared pieces every hospital module receives when its router is created. Passing them in (instead of importing
 * globals) keeps modules independent and easy to test.
 */
export interface HospitalContext {
  env: HospitalEnv;
  db: Database;
  log: Logger;
  /** Where uploaded documents are kept. */
  files: FileStore;
  /** Sends text messages (the simulator for now) and one-time codes. */
  sms: SmsProvider;
  otp: OtpService;
  /** Medicine search and name checks (Indian brand list, RxNorm). */
  drugs: DrugLookup;
}

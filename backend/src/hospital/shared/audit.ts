import type { Queryable } from "../db.js";

/**
 * Appends a line to the hospital's audit trail (who did what, when). Call it inside the same transaction as the change it
 * describes, so the trail and the data can never disagree. Nothing in this codebase updates or deletes AuditLog rows.
 * (ABHA actions have their own metadata-only trail, AbhaAuditLog, written by the ABDM module.)
 */
export async function recordAudit(db: Queryable, actor: string, action: string, detail: string): Promise<void> {
  await db.execute('INSERT INTO "AuditLog" ("facilityId", actor, action, detail) VALUES (:fid, $1, $2, $3)', [actor, action, detail]);
}

import type { Queryable } from "../../db.js";

/**
 * occupied (patient in bed) -> dirty (just vacated) -> cleaning (housekeeping started) -> vacant (ready).
 * A vacant bed can be reserved for a patient who is coming (planned admission); it is then not available to anyone else.
 */
export type BedStatus = "occupied" | "dirty" | "cleaning" | "vacant" | "reserved";

export interface BedRow {
  id: string;
  ward: string;
  bedNo: string;
  status: BedStatus;
  patientId: string | null;
  encounterId: string | null;
  statusSince: string;
  /** Who a reserved bed is being kept for (a registered patient, or just a name), until when, and why. */
  reservedPatientId: string | null;
  reservedFor: string | null;
  reservedUntil: string | null;
  reservedNote: string | null;
}

const COLUMNS = 'id, ward, "bedNo", status::text AS status, "patientId", "encounterId", "statusSince", "reservedPatientId", "reservedFor", "reservedUntil", "reservedNote"';

export const listBeds = (db: Queryable) => db.query<BedRow>(`SELECT ${COLUMNS} FROM "Bed" WHERE "facilityId" = :fid ORDER BY ward, "bedNo"`);

export const findBed = (db: Queryable, id: string) => db.queryOne<BedRow>(`SELECT ${COLUMNS} FROM "Bed" WHERE "facilityId" = :fid AND id = $1`, [id]);

/** Locks the bed row so two admissions cannot take the same bed at once. */
export const lockBed = (db: Queryable, id: string) => db.queryOne<BedRow>(`SELECT ${COLUMNS} FROM "Bed" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE`, [id]);

export const occupyBed = (db: Queryable, id: string, patientId: string, encounterId: string) =>
  db.execute(
    `UPDATE "Bed" SET status='occupied', "patientId"=$2, "encounterId"=$3, "statusSince"=now(),
            "reservedPatientId"=NULL, "reservedFor"=NULL, "reservedUntil"=NULL, "reservedNote"=NULL WHERE "facilityId" = :fid AND id = $1`,
    [id, patientId, encounterId],
  );

/** A patient has left: the bed becomes "dirty" and appears in housekeeping's queue. */
export const releaseBed = (db: Queryable, id: string) =>
  db.execute(`UPDATE "Bed" SET status='dirty', "patientId"=NULL, "encounterId"=NULL, "statusSince"=now() WHERE "facilityId" = :fid AND id = $1`, [id]);

export const reserveBed = (db: Queryable, id: string, r: { patientId: string | null; reservedFor: string; until: string | null; note: string | null }) =>
  db.execute(
    `UPDATE "Bed" SET status='reserved', "reservedPatientId"=$2, "reservedFor"=$3, "reservedUntil"=$4, "reservedNote"=$5, "statusSince"=now()
      WHERE "facilityId" = :fid AND id = $1`,
    [id, r.patientId, r.reservedFor, r.until, r.note],
  );

/** Back to vacant, with the reservation forgotten. */
export const clearReservation = (db: Queryable, id: string) =>
  db.execute(
    `UPDATE "Bed" SET status='vacant', "reservedPatientId"=NULL, "reservedFor"=NULL, "reservedUntil"=NULL, "reservedNote"=NULL, "statusSince"=now()
      WHERE "facilityId" = :fid AND id = $1`,
    [id],
  );

// ---- where a patient was, bed by bed (bed charges follow it) ---------------------------------------------------------------------

export interface BedStayRow {
  id: string;
  encounterId: string;
  bedId: string;
  ward: string;
  bedNo: string;
  fromAt: string;
  toAt: string | null;
}

export const openBedStay = (db: Queryable, encounterId: string, bed: { id: string; ward: string; bedNo: string }, at: Date = new Date()) =>
  db.execute('INSERT INTO "BedStay" ("facilityId", "encounterId", "bedId", ward, "bedNo", "fromAt") VALUES (:fid, $1,$2,$3,$4,$5)', [
    encounterId, bed.id, bed.ward, bed.bedNo, at.toISOString(),
  ]);

/** The patient has left their bed (moved or discharged). */
export const closeBedStay = (db: Queryable, encounterId: string, at: Date = new Date()) =>
  db.execute('UPDATE "BedStay" SET "toAt" = $2 WHERE "facilityId" = :fid AND "encounterId" = $1 AND "toAt" IS NULL', [encounterId, at.toISOString()]);

export const listBedStays = (db: Queryable, encounterId: string) =>
  db.query<BedStayRow>('SELECT id, "encounterId", "bedId", ward, "bedNo", "fromAt", "toAt" FROM "BedStay" WHERE "facilityId" = :fid AND "encounterId" = $1 ORDER BY "fromAt"', [
    encounterId,
  ]);

export const setBedStatus = (db: Queryable, id: string, status: BedStatus) =>
  db.execute('UPDATE "Bed" SET status = $2, "statusSince" = now() WHERE "facilityId" = :fid AND id = $1', [id, status]);

export type HousekeepingAction = "discharge_release" | "cleaning_started" | "cleaning_completed";

export interface HousekeepingLogRow {
  id: string;
  bedId: string;
  ward: string;
  bedNo: string;
  action: HousekeepingAction;
  at: string;
  by: string;
}

/** One line of bed-turnover history (patient left, cleaning started, cleaning done). */
export const logHousekeeping = (db: Queryable, bedId: string, action: HousekeepingAction, by: string) =>
  db.execute('INSERT INTO "HousekeepingLog" ("facilityId", "bedId", action, by) VALUES (:fid, $1,$2,$3)', [bedId, action, by]);

export const listHousekeepingLog = (db: Queryable, limit: number) =>
  db.query<HousekeepingLogRow>(
    `SELECT l.id, l."bedId", b.ward, b."bedNo", l.action::text AS action, l.at, l.by
       FROM "HousekeepingLog" l JOIN "Bed" b ON b.id = l."bedId"
      WHERE l."facilityId" = :fid ORDER BY l.at DESC, l.id DESC LIMIT $1`,
    [limit],
  );

export const insertBed = (db: Queryable, ward: string, bedNo: string, status: BedStatus = "vacant") =>
  db.queryOne<BedRow>(`INSERT INTO "Bed" ("facilityId", ward, "bedNo", status) VALUES (:fid, $1,$2,$3) RETURNING ${COLUMNS}`, [ward, bedNo, status]);

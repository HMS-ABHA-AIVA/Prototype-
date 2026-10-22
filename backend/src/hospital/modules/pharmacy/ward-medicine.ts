import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import type { Queryable } from "../../db.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { istDate } from "./gst.js";

/**
 * The ward medicine schedule. A prescribed medicine for an admitted patient is given times of the day (08:00, 14:00, 20:00 ...). The nurse's round then
 * lists the doses that are due, and each is marked given, missed or held, with who and when. Doses are created as their day comes (today and tomorrow),
 * never ahead of discharge. Setting a schedule also tells the pharmacy how many units the course needs (the dispense queue shows it).
 *
 * Giving a dose is the nurse's record of administration. Handing the medicine over from the pharmacy (stock and billing) is a separate step, in the pharmacy.
 */
const DEFAULT_TIMES: Record<string, string[]> = {
  OD: ["09:00"],
  QD: ["09:00"],
  HS: ["22:00"],
  BD: ["09:00", "21:00"],
  BID: ["09:00", "21:00"],
  TDS: ["08:00", "14:00", "20:00"],
  TID: ["08:00", "14:00", "20:00"],
  QID: ["06:00", "12:00", "18:00", "22:00"],
};

/** The usual times for a frequency, or null when the frequency does not say (as needed, a custom pattern). */
export function defaultTimes(frequency: string): string[] | null {
  return DEFAULT_TIMES[frequency.trim().toUpperCase().replace(/\./g, "")] ?? null;
}

const doseInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Creates the doses of every active schedule of an admission up to the end of tomorrow (Indian time). Safe to repeat. */
export async function ensureDoses(tx: Queryable, encounterId: string, now = new Date()): Promise<void> {
  const stay = await tx.queryOne<{ status: string }>('SELECT status FROM "Encounter" WHERE "facilityId" = :fid AND id = $1', [encounterId]);
  if (!stay || stay.status !== "admitted") return;
  const schedules = await tx.query<{ id: string; times: string[]; startDate: string; endDate: string | null; createdAt: string }>(
    `SELECT id, times, "startDate"::text AS "startDate", "endDate"::text AS "endDate", "createdAt" FROM "MedicationSchedule"
      WHERE "facilityId" = :fid AND "encounterId" = $1 AND status = 'active'`,
    [encounterId],
  );
  const horizon = addDays(istDate(now), 1);
  for (const s of schedules) {
    const last = s.endDate && s.endDate < horizon ? s.endDate : horizon;
    for (let date = s.startDate; date <= last; date = addDays(date, 1)) {
      for (const time of s.times) {
        const due = doseInstant(date, time);
        // A dose whose time had already passed when the schedule was made is not created as overdue: the course starts from now.
        if (due.getTime() < new Date(s.createdAt).getTime()) continue;
        await tx.execute('INSERT INTO "MedicationDose" ("facilityId", "scheduleId", "dueAt") VALUES (:fid, $1,$2) ON CONFLICT DO NOTHING', [s.id, due.toISOString()]);
      }
    }
  }
}

/** A dose with what the round needs to show; callers add `AND ...` conditions. */
const DOSE_SELECT = `SELECT d.id, d."scheduleId", d."dueAt", d.status, d."actedAt", d."actedBy", d.note, sc."encounterId", sc."prescriptionId", sc.instructions,
       p."drugName", p.dose, p.frequency, e."patientId", pt.name AS patient_name, pt.mrn,
       (SELECT ward || ' ' || "bedNo" FROM "BedStay" WHERE "facilityId" = :fid AND "encounterId" = sc."encounterId" ORDER BY "fromAt" DESC LIMIT 1) AS bed
  FROM "MedicationDose" d
  JOIN "MedicationSchedule" sc ON sc.id = d."scheduleId"
  JOIN "Prescription" p ON p.id = sc."prescriptionId"
  JOIN "Encounter" e ON e.id = sc."encounterId"
  JOIN "Patient" pt ON pt.id = e."patientId"
 WHERE d."facilityId" = :fid`;

const scheduleSchema = z.object({
  prescriptionId: z.uuid(),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "times look like 08:00")).min(1).max(6).optional(),
  days: z.number().int().min(1).max(60).optional(),
  instructions: z.string().trim().max(200).optional(),
});
const actSchema = z.object({ note: z.string().trim().max(200).optional() });

export function wardMedicineRouter({ db }: HospitalContext): Router {
  const router = Router();
  const clinical = requireRole("nurse", "doctor", "admin");

  // The nurse's round: doses due in the next few hours across every admitted patient, with overdue ones first.
  router.get("/due", clinical, async (req, res) => {
    const { hours } = parse(z.object({ hours: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    res.json(
      await db.transaction(async (tx) => {
        const admitted = await tx.query<{ id: string }>(
          `SELECT DISTINCT sc."encounterId" AS id FROM "MedicationSchedule" sc JOIN "Encounter" e ON e.id = sc."encounterId"
            WHERE sc."facilityId" = :fid AND sc.status = 'active' AND e.status = 'admitted'`,
        );
        for (const a of admitted) await ensureDoses(tx, a.id);
        return tx.query(`${DOSE_SELECT} AND d.status = 'due' AND d."dueAt" <= now() + make_interval(hours => $1) AND e.status = 'admitted' ORDER BY d."dueAt", pt.name`, [hours]);
      }),
    );
  });

  // One admission's schedules and doses: yesterday, today and tomorrow.
  router.get("/:encounterId", clinical, async (req, res) => {
    const id = uuidParam(req, "encounterId");
    res.json(
      await db.transaction(async (tx) => {
        await ensureDoses(tx, id);
        const schedules = await tx.query(
          `SELECT sc.id, sc."prescriptionId", sc.times, sc."startDate"::text AS "startDate", sc."endDate"::text AS "endDate", sc.instructions, sc.status, p."drugName", p.dose, p.frequency
             FROM "MedicationSchedule" sc JOIN "Prescription" p ON p.id = sc."prescriptionId"
            WHERE sc."facilityId" = :fid AND sc."encounterId" = $1 ORDER BY sc."createdAt"`,
          [id],
        );
        const doses = await tx.query(`${DOSE_SELECT} AND sc."encounterId" = $1 AND d."dueAt" >= now() - interval '1 day' AND d."dueAt" < now() + interval '2 days' ORDER BY d."dueAt"`, [
          id,
        ]);
        return { schedules, doses };
      }),
    );
  });

  router.post("/:encounterId/schedules", clinical, async (req, res) => {
    const encounterId = uuidParam(req, "encounterId");
    const input = parse(scheduleSchema, req.body);
    res.status(201).json(
      await db.transaction(async (tx) => {
        const stay = await tx.queryOne<{ status: string; type: string }>('SELECT status, type FROM "Encounter" WHERE "facilityId" = :fid AND id = $1 FOR UPDATE', [encounterId]);
        if (!stay || stay.type !== "IPD") throw notFound("Admission");
        if (stay.status !== "admitted") throw conflict("The patient is not admitted any more");
        const rx = await tx.queryOne<{ id: string; drugName: string; frequency: string }>(
          'SELECT id, "drugName", frequency FROM "Prescription" WHERE "facilityId" = :fid AND id = $1 AND "encounterId" = $2',
          [input.prescriptionId, encounterId],
        );
        if (!rx) throw notFound("Prescription");
        const times = [...new Set(input.times ?? defaultTimes(rx.frequency) ?? [])].sort();
        if (times.length === 0) throw badRequest(`"${rx.frequency}" does not say when to give it: choose the times`);
        const existing = await tx.queryOne(`SELECT 1 FROM "MedicationSchedule" WHERE "facilityId" = :fid AND "prescriptionId" = $1 AND status = 'active'`, [rx.id]);
        if (existing) throw conflict(`${rx.drugName} already has a schedule`);
        const today = istDate(new Date());
        const endDate = input.days ? addDays(today, input.days - 1) : null;
        await tx.execute(
          `INSERT INTO "MedicationSchedule" ("facilityId", "encounterId", "prescriptionId", times, "startDate", "endDate", instructions, "createdBy")
           VALUES (:fid, $1,$2,$3,$4,$5,$6,$7)`,
          [encounterId, rx.id, times, today, endDate, input.instructions || null, actorOf(req)],
        );
        await recordAudit(tx, actorOf(req), "Medicine Schedule Set", `${rx.drugName} at ${times.join(", ")}${endDate ? ` for ${input.days} day(s)` : ""}`);
        await ensureDoses(tx, encounterId);
        return { ok: true, times };
      }),
    );
  });

  router.post("/schedules/:id/stop", clinical, async (req, res) => {
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const schedule = await tx.queryOne<{ status: string; drugName: string }>(
        'SELECT sc.status, p."drugName" FROM "MedicationSchedule" sc JOIN "Prescription" p ON p.id = sc."prescriptionId" WHERE sc."facilityId" = :fid AND sc.id = $1 FOR UPDATE OF sc',
        [id],
      );
      if (!schedule) throw notFound("Schedule");
      if (schedule.status === "stopped") throw conflict("That schedule is already stopped");
      await tx.execute(`UPDATE "MedicationSchedule" SET status = 'stopped', "stoppedBy" = $2, "stoppedAt" = now() WHERE "facilityId" = :fid AND id = $1`, [id, actorOf(req)]);
      await tx.execute(`DELETE FROM "MedicationDose" WHERE "facilityId" = :fid AND "scheduleId" = $1 AND status = 'due'`, [id]);
      await recordAudit(tx, actorOf(req), "Medicine Schedule Stopped", schedule.drugName);
    });
    res.json({ ok: true });
  });

  for (const [action, status] of [
    ["give", "given"],
    ["miss", "missed"],
    ["hold", "held"],
  ] as const) {
    router.post(`/doses/:id/${action}`, clinical, async (req, res) => {
      const id = uuidParam(req);
      const { note } = parse(actSchema, req.body ?? {});
      if (status !== "given" && (note ?? "").length < 3) throw badRequest(`Say why the dose was ${status}`);
      res.json(
        await db.transaction(async (tx) => {
          const dose = await tx.queryOne<{ status: string; drugName: string; patientName: string }>(
            `SELECT d.status, p."drugName", pt.name AS patient_name FROM "MedicationDose" d
               JOIN "MedicationSchedule" sc ON sc.id = d."scheduleId" JOIN "Prescription" p ON p.id = sc."prescriptionId"
               JOIN "Encounter" e ON e.id = sc."encounterId" JOIN "Patient" pt ON pt.id = e."patientId"
              WHERE d."facilityId" = :fid AND d.id = $1 FOR UPDATE OF d`,
            [id],
          );
          if (!dose) throw notFound("Dose");
          if (dose.status !== "due") throw conflict(`That dose is already marked ${dose.status}`);
          await tx.execute('UPDATE "MedicationDose" SET status = $2, "actedAt" = now(), "actedBy" = $3, note = $4 WHERE "facilityId" = :fid AND id = $1', [
            id, status, actorOf(req), note || null,
          ]);
          await recordAudit(
            tx,
            actorOf(req),
            `Dose ${status === "given" ? "Given" : status === "missed" ? "Missed" : "Held"}`,
            `${dose.drugName} for ${dose.patientName}${note ? `: ${note}` : ""}`,
          );
          return tx.queryOne(`${DOSE_SELECT} AND d.id = $1`, [id]);
        }),
      );
    });
  }

  return router;
}

/** The scheduled times of prescriptions (so the pharmacy can see which ones are on the ward schedule). */
export async function scheduledTimesFor(db: Queryable, prescriptionIds: string[]): Promise<Map<string, { times: string[]; days: number | null }>> {
  if (prescriptionIds.length === 0) return new Map();
  const rows = await db.query<{ prescriptionId: string; times: string[]; startDate: string; endDate: string | null }>(
    `SELECT "prescriptionId", times, "startDate"::text AS "startDate", "endDate"::text AS "endDate" FROM "MedicationSchedule"
      WHERE "facilityId" = :fid AND status = 'active' AND "prescriptionId" = ANY($1::text[])`,
    [prescriptionIds],
  );
  return new Map(
    rows.map((r) => [r.prescriptionId, { times: r.times, days: r.endDate ? Math.round((Date.parse(r.endDate) - Date.parse(r.startDate)) / 86_400_000) + 1 : null }]),
  );
}

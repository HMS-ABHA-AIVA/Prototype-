import { Router, type Request } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { recordAudit } from "../../shared/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { findPatient } from "../patients/patients.repository.js";
import { clearReservation, findBed, insertBed, listBeds, listHousekeepingLog, lockBed, logHousekeeping, reserveBed, setBedStatus } from "./beds.repository.js";

/**
 * Bed board and housekeeping turnover. Beds become "dirty" automatically when a patient is discharged
 * (see the encounters service); housekeeping then moves them dirty -> cleaning -> vacant here.
 */
export function bedsRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json(await listBeds(db));
  });

  // Bed turnover history for the housekeeping screen (newest first).
  router.get("/housekeeping-log", async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json(await listHousekeepingLog(db, limit));
  });

  router.post("/", requireRole("admin"), async (req, res) => {
    const { ward, bedNo } = parse(z.object({ ward: z.string().trim().min(1).max(60), bedNo: z.string().trim().min(1).max(20) }), req.body);
    const bed = await db.transaction(async (tx) => {
      const created = await insertBed(tx, ward, bedNo);
      await recordAudit(tx, actorOf(req), "Bed Added", `${ward} ${bedNo}`);
      return created;
    });
    res.status(201).json(bed);
  });

  // Keeps a vacant bed for a patient who is coming (a planned admission). The admission takes it, or the reservation is cleared.
  router.post("/:id/reserve", requireRole("front_office", "nurse", "admin"), async (req, res) => {
    const id = uuidParam(req);
    const input = parse(
      z
        .object({
          patientId: z.uuid().optional(),
          reservedFor: z.string().trim().min(2).max(120).optional(),
          until: z.iso.datetime({ offset: true }).optional(),
          note: z.string().trim().max(200).optional(),
        })
        .refine((v) => v.patientId || v.reservedFor, { message: "Say who the bed is for" }),
      req.body,
    );
    if (input.until && new Date(input.until) < new Date()) throw conflict("The reservation cannot end in the past");
    res.json(
      await db.transaction(async (tx) => {
        const bed = await lockBed(tx, id);
        if (!bed) throw notFound("Bed");
        if (bed.status !== "vacant") throw conflict(`Bed ${bed.ward} ${bed.bedNo} is ${bed.status}: only a vacant bed can be reserved`);
        const patient = input.patientId ? await findPatient(tx, input.patientId) : null;
        if (input.patientId && !patient) throw notFound("Patient");
        const who = patient?.name ?? input.reservedFor!;
        await reserveBed(tx, id, { patientId: patient?.id ?? null, reservedFor: who, until: input.until ?? null, note: input.note ?? null });
        await recordAudit(tx, actorOf(req), "Bed Reserved", `${bed.ward} ${bed.bedNo} for ${who}`);
        return findBed(tx, id);
      }),
    );
  });

  router.post("/:id/clear-reservation", requireRole("front_office", "nurse", "admin"), async (req, res) => {
    const id = uuidParam(req);
    res.json(
      await db.transaction(async (tx) => {
        const bed = await lockBed(tx, id);
        if (!bed) throw notFound("Bed");
        if (bed.status !== "reserved") throw conflict(`Bed ${bed.ward} ${bed.bedNo} is not reserved`);
        await clearReservation(tx, id);
        await recordAudit(tx, actorOf(req), "Bed Reservation Cleared", `${bed.ward} ${bed.bedNo} (was for ${bed.reservedFor ?? "someone"})`);
        return findBed(tx, id);
      }),
    );
  });

  router.post("/:id/start-cleaning", requireRole("housekeeping", "nurse", "admin"), async (req, res) => {
    res.json(await moveBed(req, "dirty", "cleaning", "Bed Cleaning Started"));
  });

  router.post("/:id/complete-cleaning", requireRole("housekeeping", "nurse", "admin"), async (req, res) => {
    res.json(await moveBed(req, "cleaning", "vacant", "Bed Cleaning Completed"));
  });

  // One step of the housekeeping pipeline. Refuses to skip steps (e.g. cannot "complete" a bed nobody started).
  async function moveBed(req: Request, from: "dirty" | "cleaning", to: "cleaning" | "vacant", action: string) {
    const id = uuidParam(req);
    return db.transaction(async (tx) => {
      const bed = await lockBed(tx, id);
      if (!bed) throw notFound("Bed");
      if (bed.status !== from) throw conflict(`Bed ${bed.ward} ${bed.bedNo} is ${bed.status}, not ${from}`);
      await setBedStatus(tx, id, to);
      await logHousekeeping(tx, id, to === "cleaning" ? "cleaning_started" : "cleaning_completed", actorOf(req));
      await recordAudit(tx, actorOf(req), action, `${bed.ward} ${bed.bedNo}`);
      return findBed(tx, id);
    });
  }

  return router;
}

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { recordAudit } from "../../shared/audit.js";
import { conflict, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { deleteDraftRun, finalizeRun, generateRun, getRun, listRuns, markRunPaid, monthIsLocked, setDeduction } from "./payroll.service.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM");
const shift = z.enum(["morning", "evening", "night"]);

/** Attendance (per shift) and payroll. Administrators only: both contain pay information. */
export function payrollRouter({ db }: HospitalContext): Router {
  const router = Router();
  router.use(requireRole("admin"));

  // ---- Attendance ----------------------------------------------------------------------------
  router.get("/attendance", async (req, res) => {
    const q = parse(z.object({ month, staffId: z.uuid().optional() }), req.query);
    res.json(
      await db.query(
        `SELECT id, "staffId", date, shift, status FROM "Attendance"
          WHERE "facilityId" = :fid AND to_char(date, 'YYYY-MM') = $1 AND ($2::text IS NULL OR "staffId" = $2)
          ORDER BY date, CASE shift WHEN 'morning' THEN 1 WHEN 'evening' THEN 2 ELSE 3 END`,
        [q.month, q.staffId ?? null],
      ),
    );
  });

  // Records one person's attendance for one shift (replacing an earlier mark). Marking two shifts on a date is a double shift.
  router.put("/attendance", async (req, res) => {
    const a = parse(z.object({ staffId: z.uuid(), date: z.iso.date(), shift, status: z.enum(["present", "absent", "leave", "half_day"]) }), req.body);
    const row = await db.transaction(async (tx) => {
      const person = await tx.queryOne<{ name: string }>('SELECT name FROM "Staff" WHERE "facilityId" = :fid AND id = $1', [a.staffId]);
      if (!person) throw notFound("Staff member");
      if (await monthIsLocked(tx, a.date.slice(0, 7))) throw conflict(`Payroll for ${a.date.slice(0, 7)} is already finalized; attendance can no longer change`);
      const saved = await tx.queryOne(
        `INSERT INTO "Attendance" ("facilityId", "staffId", date, shift, status) VALUES (:fid, $1,$2,$3,$4)
         ON CONFLICT ("staffId", date, shift) DO UPDATE SET status = EXCLUDED.status
         RETURNING id, "staffId", date, shift, status`,
        [a.staffId, a.date, a.shift, a.status],
      );
      await recordAudit(tx, actorOf(req), "Attendance Marked", `${person.name} — ${a.date} ${a.shift}: ${a.status}`);
      return saved;
    });
    res.json(row);
  });

  // ---- Payroll runs --------------------------------------------------------------------------
  router.get("/runs", async (_req, res) => {
    res.json(await listRuns(db));
  });

  router.get("/runs/:id", async (req, res) => {
    res.json(await getRun(db, uuidParam(req)));
  });

  router.post("/runs", async (req, res) => {
    const { month: m } = parse(z.object({ month }), req.body);
    res.status(201).json(await generateRun(db, m, actorOf(req)));
  });

  router.patch("/runs/:id/lines/:staffId", async (req, res) => {
    const { deductions } = parse(z.object({ deductions: z.number().min(0).max(100_000_000) }), req.body);
    res.json(await setDeduction(db, uuidParam(req), uuidParam(req, "staffId"), deductions, actorOf(req)));
  });

  router.post("/runs/:id/finalize", async (req, res) => {
    res.json(await finalizeRun(db, uuidParam(req), actorOf(req)));
  });

  router.post("/runs/:id/pay", async (req, res) => {
    res.json(await markRunPaid(db, uuidParam(req), actorOf(req)));
  });

  router.delete("/runs/:id", async (req, res) => {
    await deleteDraftRun(db, uuidParam(req), actorOf(req));
    res.status(204).end();
  });

  return router;
}

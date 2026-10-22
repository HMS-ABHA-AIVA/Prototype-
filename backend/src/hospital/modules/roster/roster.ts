import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { recordAudit } from "../../shared/audit.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/http.js";
import { parse } from "../../shared/validate.js";

/**
 * The duty roster: who is planned to work which shift in which department. This is the plan; what actually
 * happened is recorded in attendance (modules/payroll). A person may hold several shifts on one date (a double shift).
 */
export interface RosterRow {
  id: string;
  staffId: string;
  staffName: string;
  date: string;
  shift: "morning" | "evening" | "night";
  department: string;
}

const date = z.iso.date();
const shift = z.enum(["morning", "evening", "night"]);

/** The Indian calendar day, which is what "this week" means at the hospital. */
const TODAY_IST = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

const SELECT = `/* fragment: every caller adds r."facilityId" = :fid */ SELECT r.id, r."staffId", s.name AS "staffName", r.date, r.shift, r.department
                  FROM "RosterEntry" r JOIN "Staff" s ON s.id = r."staffId"`;

export function rosterRouter({ db }: HospitalContext): Router {
  const router = Router();
  const planners = requireRole("front_office", "admin");

  // Everyone signed in may see the roster. ?from and ?to (inclusive) default to the current week.
  router.get("/", async (req, res) => {
    const { from, to, staffId } = parse(z.object({ from: date.optional(), to: date.optional(), staffId: z.uuid().optional() }), req.query);
    res.json(
      await db.query<RosterRow>(
        `${SELECT}
          WHERE r."facilityId" = :fid
            AND r.date BETWEEN COALESCE($1::date, date_trunc('week', ${TODAY_IST})::date)
                           AND COALESCE($2::date, date_trunc('week', ${TODAY_IST})::date + 6)
            AND ($3::text IS NULL OR r."staffId" = $3)
          ORDER BY r.date, CASE r.shift WHEN 'morning' THEN 1 WHEN 'evening' THEN 2 ELSE 3 END, s.name`,
        [from ?? null, to ?? null, staffId ?? null],
      ),
    );
  });

  // Adds the assignment if it does not exist, removes it if it does (what the roster grid's cell click does).
  router.post("/toggle", planners, async (req, res) => {
    const { staffId, date: day, shift: sh, department } = parse(z.object({ staffId: z.uuid(), date, shift, department: z.string().trim().min(1).max(80) }), req.body);
    const result = await db.transaction(async (tx) => {
      const staff = await tx.queryOne<{ name: string; active: boolean }>('SELECT name, active FROM "Staff" WHERE "facilityId" = :fid AND id = $1', [staffId]);
      if (!staff) throw notFound("Staff member");
      const removed = await tx.execute('DELETE FROM "RosterEntry" WHERE "facilityId" = :fid AND "staffId"=$1 AND date=$2 AND shift=$3', [staffId, day, sh]);
      if (removed > 0) {
        await recordAudit(tx, actorOf(req), "Roster Assignment Removed", `${staff.name} — ${day} ${sh}`);
        return { assigned: false as const };
      }
      if (!staff.active) throw badRequest(`${staff.name} is deactivated and cannot be rostered`);
      const entry = await tx.queryOne<{ id: string }>(
        'INSERT INTO "RosterEntry" ("facilityId", "staffId", date, shift, department) VALUES (:fid, $1,$2,$3,$4) RETURNING id',
        [staffId, day, sh, department],
      );
      await recordAudit(tx, actorOf(req), "Roster Assignment Added", `${staff.name} — ${day} ${sh} (${department})`);
      return { assigned: true as const, id: entry!.id };
    });
    res.json(result);
  });

  // Repeats one week's roster on another week, skipping assignments that already exist there.
  router.post("/copy-week", planners, async (req, res) => {
    const { fromStart, toStart } = parse(z.object({ fromStart: date, toStart: date }), req.body);
    if (fromStart === toStart) throw badRequest("Choose a different week to copy to");
    const copied = await db.transaction(async (tx) => {
      const n = await tx.execute(
        `INSERT INTO "RosterEntry" ("facilityId", "staffId", date, shift, department)
         SELECT r."facilityId", r."staffId", r.date + ($2::date - $1::date), r.shift, r.department
           FROM "RosterEntry" r JOIN "Staff" s ON s.id = r."staffId" AND s.active
          WHERE r."facilityId" = :fid AND r.date BETWEEN $1::date AND $1::date + 6
         ON CONFLICT ("staffId", date, shift) DO NOTHING`,
        [fromStart, toStart],
      );
      await recordAudit(tx, actorOf(req), "Roster Week Copied", `${fromStart} -> ${toStart} (${n} shift(s))`);
      return n;
    });
    res.json({ copied });
  });

  return router;
}

import { Router } from "express";
import { z } from "zod";
import type { HospitalContext } from "../../context.js";
import { parse } from "../../shared/validate.js";

/** Read-only view of the hospital's audit trail. Rows are written by the services (shared/audit.ts); nothing here edits or deletes. */
export function auditRouter({ db }: HospitalContext): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const { limit, actor } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), actor: z.string().trim().max(80).optional() }),
      req.query,
    );
    res.json(
      await db.query(
        `SELECT id, at, actor, action, detail FROM "AuditLog" WHERE "facilityId" = :fid AND ($1::text IS NULL OR actor = $1) ORDER BY at DESC, id DESC LIMIT $2`,
        [actor ?? null, limit],
      ),
    );
  });

  return router;
}

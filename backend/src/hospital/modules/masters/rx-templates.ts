import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/session.js";
import type { HospitalContext } from "../../context.js";
import { recordAudit } from "../../shared/audit.js";
import { forbidden, notFound } from "../../shared/errors.js";
import { actorOf, staffOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";

/**
 * Prescription templates: a doctor's saved set of medicines (or one the hospital shares with every doctor) that can be dropped into a
 * prescription with one click. A template only fills in the form; the doctor still reviews each line and the usual allergy and
 * duplicate checks run when it is saved.
 */
export interface TemplateItem {
  drugName: string;
  dose: string;
  frequency: string;
  duration: string;
}
export interface TemplateRow {
  id: string;
  name: string;
  diagnosis: string | null;
  items: TemplateItem[];
  /** True when every doctor can use it; false when it belongs to one doctor. */
  shared: boolean;
  ownerId: string | null;
  ownerName: string | null;
}

const SELECT = `/* fragment: every caller adds t."facilityId" = :fid */ SELECT t.id, t.name, t.diagnosis, t.items, (t."staffId" IS NULL) AS shared, t."staffId" AS owner_id, s.name AS owner_name
                  FROM "RxTemplate" t LEFT JOIN "Staff" s ON s.id = t."staffId"`;

const itemSchema = z.object({
  drugName: z.string().trim().min(1).max(120),
  dose: z.string().trim().min(1).max(60),
  frequency: z.string().trim().min(1).max(60),
  duration: z.string().trim().min(1).max(60),
});
const bodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  diagnosis: z.string().trim().max(200).nullable().default(null),
  items: z.array(itemSchema).min(1).max(30),
  /** Only an administrator can share a template with every doctor. */
  shared: z.boolean().default(false),
});

export function rxTemplatesRouter({ db }: HospitalContext): Router {
  const router = Router();
  router.use(requireRole("doctor", "admin"));

  const find = (id: string) => db.queryOne<TemplateRow>(`${SELECT} WHERE t."facilityId" = :fid AND t.id = $1`, [id]);

  // A doctor sees the shared templates and their own; an administrator sees all.
  router.get("/", async (req, res) => {
    const staff = staffOf(req);
    res.json(
      await db.query<TemplateRow>(
        `${SELECT} WHERE t."facilityId" = :fid AND ($1::boolean OR t."staffId" IS NULL OR t."staffId" = $2) ORDER BY (t."staffId" IS NULL) DESC, t.name`,
        [staff.role === "admin", staff.id],
      ),
    );
  });

  router.post("/", async (req, res) => {
    const staff = staffOf(req);
    const t = parse(bodySchema, req.body);
    const shared = t.shared && staff.role === "admin";
    const id = await db.transaction(async (tx) => {
      const row = await tx.queryOne<{ id: string }>('INSERT INTO "RxTemplate" ("facilityId", name, "staffId", diagnosis, items) VALUES (:fid, $1,$2,$3,$4::jsonb) RETURNING id', [
        t.name, shared ? null : staff.id, t.diagnosis, JSON.stringify(t.items),
      ]);
      await recordAudit(tx, actorOf(req), "Prescription Template Saved", `${t.name} (${t.items.length} medicine${t.items.length === 1 ? "" : "s"})${shared ? ", shared" : ""}`);
      return row!.id;
    });
    res.status(201).json(await find(id));
  });

  router.put("/:id", async (req, res) => {
    const staff = staffOf(req);
    const id = uuidParam(req);
    const t = parse(bodySchema, req.body);
    const current = await find(id);
    if (!current) throw notFound("Template");
    if (current.ownerId !== staff.id && staff.role !== "admin") throw forbidden("This template belongs to another doctor");
    await db.transaction(async (tx) => {
      const shared = staff.role === "admin" ? t.shared : current.shared;
      await tx.execute('UPDATE "RxTemplate" SET name=$2, diagnosis=$3, items=$4::jsonb, "staffId"=$5 WHERE "facilityId" = :fid AND id=$1', [
        id, t.name, t.diagnosis, JSON.stringify(t.items), shared ? null : current.ownerId ?? staff.id,
      ]);
      await recordAudit(tx, actorOf(req), "Prescription Template Updated", t.name);
    });
    res.json(await find(id));
  });

  router.delete("/:id", async (req, res) => {
    const staff = staffOf(req);
    const id = uuidParam(req);
    const current = await find(id);
    if (!current) throw notFound("Template");
    if (current.ownerId !== staff.id && staff.role !== "admin") throw forbidden("This template belongs to another doctor");
    await db.transaction(async (tx) => {
      await tx.execute('DELETE FROM "RxTemplate" WHERE "facilityId" = :fid AND id = $1', [id]);
      await recordAudit(tx, actorOf(req), "Prescription Template Deleted", current.name);
    });
    res.status(204).end();
  });

  return router;
}

import { Router } from "express";
import type { HospitalContext } from "../../context.js";
import { aiStatus } from "./ai-client.js";

/** Tells the screens whether the AI assistant is switched on, and whether the provider may read what is sent. */
export function aiRouter({ env }: HospitalContext): Router {
  const router = Router();
  router.get("/status", (_req, res) => {
    res.json(aiStatus(env));
  });
  return router;
}

import { Router } from "express";
import type { HospitalContext } from "../../context.js";
import { investigationsRouter } from "./investigations.js";
import { itemPricingRouter } from "./item-pricing.js";
import { rxTemplatesRouter } from "./rx-templates.js";
import { servicesRouter } from "./services.js";
import { settingsRouter } from "./settings.js";

/**
 * /api/v1/masters: the lists billing, orders and prescriptions read. Anyone signed in can read the services and investigations (the
 * screens that order or charge them need the list); changing them is for administrators.
 *   /settings            hospital billing and print settings
 *   /services, /wards    chargeable services and each ward's daily bed charge
 *   /investigations      lab and radiology tests, with normal ranges
 *   /panels/:id/item-rates   a panel's special rates for those
 *   /rx-templates        saved prescriptions
 */
export function mastersRouter(ctx: HospitalContext): Router {
  const router = Router();
  router.use("/settings", settingsRouter(ctx));
  router.use(servicesRouter(ctx));
  router.use(investigationsRouter(ctx));
  router.use(itemPricingRouter(ctx));
  router.use("/rx-templates", rxTemplatesRouter(ctx));
  return router;
}

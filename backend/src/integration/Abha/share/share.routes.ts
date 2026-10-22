import express from "express";
import { verifyUserJwt } from "../../../common/middlewares/verifyUserJwt.js";
import { rateLimit } from "../../../common/middlewares/rateLimit.middleware.js";
import { auditAbha } from "../../../common/middlewares/auditAbha.middleware.js";
import { dismissShareController, listSharesController, receivePatientShareController, registerShareController, shareConfigController } from "./share.controller.js";

// Mounted at /api/v3/hip: the path ABDM calls on our bridge URL (public, verified in the controller).
export const bridgeRouter = express.Router();
bridgeRouter.post("/patient/share", rateLimit({ windowMs: 60_000, max: 120, key: (req) => `share-in:${req.ip}` }), receivePatientShareController);

// Mounted at /api/abha/shares: the staff queue.
export const shareStaffRouter = express.Router();
shareStaffRouter.get("/", verifyUserJwt, listSharesController);
shareStaffRouter.get("/config", verifyUserJwt, shareConfigController);
shareStaffRouter.post("/:shareId/register", verifyUserJwt, auditAbha("SHARE_REGISTER"), registerShareController);
shareStaffRouter.post("/:shareId/dismiss", verifyUserJwt, auditAbha("SHARE_DISMISS"), dismissShareController);

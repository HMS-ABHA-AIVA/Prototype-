import { Router } from "express";
import { createPatientController,getAllPatientController,getPatientTransactionsController,updatePatientController } from "../patients/patient.controller.js";
import { verifyUserJwt, type userAuthRequest } from "../../common/middlewares/verifyUserJwt.js";

import { uuidParam } from "../../common/utils/validate.js";
import { logSecurityEvent } from "../../common/utils/securityLog.js";
import { deletePatientService } from "./patient.service.js";
import type { Response, NextFunction } from "express";

const patientRouter = Router();

patientRouter.get("/",verifyUserJwt,getAllPatientController);
patientRouter.post("/create",verifyUserJwt,createPatientController)
patientRouter.patch("/:patientId",verifyUserJwt,updatePatientController);
patientRouter.get("/:patientId/transactions",verifyUserJwt,getPatientTransactionsController);

// Permanently removes a patient record and its ABHA link and OTP history from this hospital (testing aid).
// Nothing is deleted at ABDM: the person's ABHA itself is untouched and can be linked again.
patientRouter.delete("/:patientId", verifyUserJwt, async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    const patientId = uuidParam(req.params.patientId, "patient ID");
    await deletePatientService(patientId, req.user!.facilityId);
    logSecurityEvent("PATIENT_DELETED", req, { patientId });
    res.status(200).json({ success: true, message: "Patient deleted" });
  } catch (error) {
    next(error);
  }
});

export default patientRouter;
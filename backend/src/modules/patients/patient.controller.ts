import type { Response, NextFunction } from "express"
import { ApiError } from "../../common/errors/appError.js";
import type { userAuthRequest } from "../../common/middlewares/verifyUserJwt.js";
import { createPatientSchema, listPatientsQuerySchema, updatePatientSchema } from "../../common/validators/patient.validation.js";
import { createPatientService,getAllPatientsService,getPatientTransactionsService,updatePatientService} from "./patient.service.js";
import { logSecurityEvent } from "../../common/utils/securityLog.js";
import { PENDING_PATIENT_NAME } from "../../common/utils/abhaMatch.js";




export const createPatientController = async (req: userAuthRequest,res: Response,next :NextFunction) => {
    try {
    if(!req.user){
        throw new ApiError(401,"unauthrorized access");
    }
    const result = createPatientSchema.safeParse(req.body);
    if (!result.success) {
            const message = result.error.issues
                .map((issue: any) => issue.message)
                .join(", ");

            throw new ApiError(400, `Invalid request body: ${message}`);
        }


    const facilityId = req.user.facilityId;

    if (!facilityId) {
        throw new ApiError(401, "Unauthorized");
    }

    const patient = await createPatientService(
        result.data.name ?? PENDING_PATIENT_NAME,
        result.data.phone ?? "",
        result.data.email,
        facilityId,
        result.data.dateOfBirth,
        result.data.gender
    );

    return res.status(201).json({
        success: true,
        message: "Patient created successfully",
        data: patient
    });
    } catch (error) {
        next(error)
    }
   
};

export const getAllPatientController = async (req: userAuthRequest,res: Response,next: NextFunction) => {
    try {
        if (!req.user) {
            throw new ApiError(401, "Unauthorized access");
        }

        const facilityId = req.user.facilityId;

        if (!facilityId) {
            throw new ApiError(401, "Unauthorized");
        }

        const query = listPatientsQuerySchema.safeParse(req.query);
        if (!query.success) {
            throw new ApiError(400, `Invalid query parameters: ${query.error.issues.map((issue) => issue.message).join(", ")}`, [], "VALIDATION");
        }

        const patients = await getAllPatientsService(facilityId, query.data.limit, query.data.page);

        return res.status(200).json({
            success: true,
            message: "Patients retrieved successfully",
            data: patients,
        });
    } catch (error) {
        next(error);
    }
};

export const getPatientTransactionsController = async (
  req: userAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user) {
      throw new ApiError(401, "Unauthorized access");
    }

    const facilityId = req.user.facilityId;

    if (!facilityId) {
      throw new ApiError(401, "Unauthorized");
    }

    const { patientId } = req.params;

    if (typeof patientId !== "string") {
      throw new ApiError(400, "Patient ID is required");
    }

    const transactions = await getPatientTransactionsService(patientId,facilityId);

    return res.status(200).json({
      success: true,
      message: "Patient transactions retrieved successfully",
      data: transactions,
    });
  } catch (error) {
    next(error);
  }
};
export const updatePatientController = async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      throw new ApiError(401, "Unauthorized access");
    }

    const { patientId } = req.params;
    if (typeof patientId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patientId)) {
      throw new ApiError(400, "Invalid request: patient ID must be a UUID", [], "VALIDATION");
    }

    const parsed = updatePatientSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, `Invalid request body: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`, [], "VALIDATION");
    }

    const patient = await updatePatientService(patientId, req.user.facilityId, parsed.data);

    // which fields changed, never their values
    logSecurityEvent("PATIENT_UPDATED", req, { patientId, fields: Object.keys(parsed.data).join(",") });

    return res.status(200).json({
      success: true,
      message: "Patient updated successfully",
      data: patient,
    });
  } catch (error) {
    next(error);
  }
};

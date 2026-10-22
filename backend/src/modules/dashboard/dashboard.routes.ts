import { Router } from "express";
import type { Response, NextFunction } from "express";
import { verifyUserJwt, type userAuthRequest } from "../../common/middlewares/verifyUserJwt.js";
import { getDashboardService } from "./dashboard.service.js";

const dashboardRouter = Router();

dashboardRouter.get("/", verifyUserJwt, async (req: userAuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = await getDashboardService(req.user!.facilityId);
    res.status(200).json({ success: true, message: "Dashboard retrieved", data });
  } catch (error) {
    next(error);
  }
});

export default dashboardRouter;

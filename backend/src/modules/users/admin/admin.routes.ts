import express from "express";
import {adminLogin, adminLogout} from "./admin.controller.js";
import { verifyUserJwt } from "../../../common/middlewares/verifyUserJwt.js";
import { loginRateLimit } from "../../../common/middlewares/authRateLimit.js";


const adminRouter = express.Router();

adminRouter.post("/login", ...loginRateLimit, adminLogin);
adminRouter.post("/logout",verifyUserJwt,adminLogout)
export default adminRouter;
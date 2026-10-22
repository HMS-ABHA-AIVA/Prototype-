import express from "express";
import { registerFacility, loginFacility, logoutFacility, addAbdmDetails, createAdmin } from "./facility.controller.js";
import {verifyFacilityJwt} from "../../common/middlewares/verifyFacilityJwt.js"
import { loginRateLimit, registerRateLimit } from "../../common/middlewares/authRateLimit.js";
const facilityRouter = express.Router();

facilityRouter.post("/register", registerRateLimit, registerFacility);
facilityRouter.post("/login", ...loginRateLimit, loginFacility);
facilityRouter.post("/logout",verifyFacilityJwt, logoutFacility);
facilityRouter.post("/add-abdm-details",verifyFacilityJwt, addAbdmDetails);
facilityRouter.post("/create-admin",verifyFacilityJwt,createAdmin)
export default facilityRouter;
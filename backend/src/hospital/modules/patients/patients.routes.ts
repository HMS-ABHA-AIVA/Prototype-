import { Router } from "express";
import type { HospitalContext } from "../../context.js";
import { actorOf } from "../../shared/http.js";
import { parse, uuidParam } from "../../shared/validate.js";
import { registerPatientSchema, searchPatientsSchema, updatePatientSchema } from "./patients.schemas.js";
import { editPatient, getPatient, listPatients, registerPatient } from "./patients.service.js";

export function patientsRouter({ db }: HospitalContext): Router {
  const router = Router();

  // GET /patients?search=ramesh&limit=20   (search matches name, MRN, mobile, ABHA number or ABHA address)
  router.get("/", async (req, res) => {
    const { search, limit } = parse(searchPatientsSchema, req.query);
    res.json(await listPatients(db, search, limit));
  });

  router.post("/", async (req, res) => {
    const input = parse(registerPatientSchema, req.body);
    res.status(201).json(await registerPatient(db, input, actorOf(req)));
  });

  router.get("/:id", async (req, res) => {
    res.json(await getPatient(db, uuidParam(req)));
  });

  router.patch("/:id", async (req, res) => {
    const input = parse(updatePatientSchema, req.body);
    res.json(await editPatient(db, uuidParam(req), input, actorOf(req)));
  });

  return router;
}

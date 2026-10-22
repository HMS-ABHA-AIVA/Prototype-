import { z } from "zod";

const id = z.uuid();
const text = (max = 500) => z.string().trim().max(max);

export const listEncountersSchema = z.object({
  type: z.enum(["OPD", "IPD", "ER"]).optional(),
  status: z
    .enum(["awaiting_payment", "waiting", "in_consult", "in_er", "admitted", "discharged", "referred", "lama", "deceased", "billed", "closed", "cancelled"])
    .optional(),
  patientId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** detail=true returns each visit with its note, vitals, prescriptions and orders (one request instead of one per visit). */
  detail: z.enum(["true", "false"]).default("false"),
});

export const checkInOpdSchema = z.object({ patientId: id, department: text(80).min(1), doctorId: id });

export const checkInErSchema = z.object({
  patientId: id,
  chiefComplaint: text(300).min(1),
  triageLevel: z.enum(["red", "yellow", "green", "black"]),
  arrivalMode: z.enum(["walk_in", "ambulance", "referred_in"]).default("walk_in"),
  doctorId: id,
});

/** Admit a patient straight to a bed (no OPD/ER visit first). */
export const admitDirectSchema = z.object({
  patientId: id,
  department: text(80).min(1),
  doctorId: id,
  bedId: id,
  panelId: id.nullable().optional(),
  beneficiaryId: text(60).optional(),
});
/** Admit from an existing OPD or ER encounter; the patient is taken from that encounter. */
export const admitFromSchema = z.object({
  department: text(80).min(1),
  doctorId: id,
  bedId: id,
  panelId: id.nullable().optional(),
  beneficiaryId: text(60).optional(),
});

export const soapSchema = z.object({
  subjective: text(4000).default(""),
  objective: text(4000).default(""),
  assessment: text(4000).default(""),
  plan: text(4000).default(""),
});

export const vitalsSchema = z
  .object({
    tempF: z.number().min(80).max(115).optional(),
    pulse: z.number().int().min(20).max(250).optional(),
    bp: z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/, "blood pressure looks like 120/80").optional(),
    spo2: z.number().int().min(50).max(100).optional(),
    rr: z.number().int().min(4).max(80).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Record at least one measurement" });

export const prescriptionSchema = z.object({
  drugName: text(120).min(1),
  dose: text(60).min(1),
  frequency: text(40).min(1),
  duration: text(40).min(1),
  /** True when the line began as an AI suggestion that the doctor reviewed and chose to add. */
  aiSuggested: z.boolean().default(false),
});

export const orderSchema = z.object({
  type: z.enum(["lab", "radiology"]),
  name: text(120).min(1),
  /** The test picked from the hospital's list, if it was picked rather than typed. */
  investigationId: id.optional(),
});

export const triageSchema = z.object({ triageLevel: z.enum(["red", "yellow", "green", "black"]) });

export const erDispositionSchema = z
  .object({
    disposition: z.enum(["discharged", "referred", "lama", "deceased"]),
    note: text(1000).min(1),
    referredTo: text(160).optional(),
  })
  .refine((v) => v.disposition !== "referred" || !!v.referredTo, { path: ["referredTo"], message: "Say which facility the patient is referred to" });

/** Move an admitted patient to another (vacant) bed. */
export const transferBedSchema = z.object({ bedId: id });

export const dischargeSchema = z.object({ summary: text(8000).min(1) });

export type CheckInOpdInput = z.output<typeof checkInOpdSchema>;
export type CheckInErInput = z.output<typeof checkInErSchema>;
export type AdmitDirectInput = z.output<typeof admitDirectSchema>;
export type TransferBedInput = z.output<typeof transferBedSchema>;
export type AdmitFromInput = z.output<typeof admitFromSchema>;
export type SoapInput = z.output<typeof soapSchema>;
export type VitalsInput = z.output<typeof vitalsSchema>;
export type PrescriptionInput = z.output<typeof prescriptionSchema>;
export type OrderInput = z.output<typeof orderSchema>;
export type ErDispositionInput = z.output<typeof erDispositionSchema>;

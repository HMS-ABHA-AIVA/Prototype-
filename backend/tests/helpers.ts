import "./env.js";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../src/config/db.js";

// Tests talk to a RUNNING backend over HTTP (default http://localhost:5000) and use a throwaway hospital of their own,
// created straight in the database and removed afterwards, so they never touch real data.
export const BASE = process.env.TEST_API ?? "http://localhost:5000";

export interface Reply {
  status: number;
  json: any;
  cookie: string;
}

export async function api(method: string, path: string, options: { body?: unknown; cookie?: string } = {}): Promise<Reply> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(method !== "GET" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { status: res.status, json: await res.json().catch(() => null), cookie };
}

export const strongPassword = () => `Qa${randomBytes(6).toString("hex")}9Zx`;

export interface QaHospital {
  facilityId: string;
  hfrId: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
}

export async function createQaHospital(): Promise<QaHospital> {
  const tag = randomBytes(4).toString("hex");
  const adminPassword = strongPassword();
  const facility = await prisma.facility.create({
    data: { name: `QA Hospital ${tag}`, hfrId: `QA-${tag}`, email: `qa-${tag}@example.test`, passwordHash: await bcrypt.hash(strongPassword(), 4) },
  });
  const user = await prisma.user.create({
    data: { name: "QA Admin", email: `qa-admin-${tag}@example.test`, passwordHash: await bcrypt.hash(adminPassword, 4), facilityId: facility.id, role: "admin" },
  });
  await prisma.staff.create({ data: { facilityId: facility.id, userId: user.id, name: "QA Admin", role: "admin", department: "Administration" } });
  return { facilityId: facility.id, hfrId: facility.hfrId, adminEmail: user.email, adminPassword, adminUserId: user.id };
}

// The hospital-module tables of one facility, children before parents, so a throwaway hospital can be removed completely.
const HOSPITAL_TABLES = [
  "MedicationDose", "MedicationSchedule", "PharmacySaleItem", "PharmacySale", "StockLedger", "PurchaseItem", "Purchase", "DrugBatch", "Supplier", "Drug",
  "OrderAttachment", "ReportAmendment", "OrderResult", "LabInvoiceItem", "ClinicalOrder", "LabInvoice", "InvestigationParameter", "PanelItemRate",
  "IpdPayment", "IpdCharge", "BedStay", "Birth", "EncounterDocument", "BillItem", "Bill", "OpdPayment", "Vital", "Prescription",
];

export async function removeHospitalData(facilityId: string) {
  for (const table of HOSPITAL_TABLES) await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "facilityId" = $1`, facilityId);
  await prisma.$executeRawUnsafe(`UPDATE "Bed" SET "encounterId" = NULL, "patientId" = NULL, "reservedPatientId" = NULL WHERE "facilityId" = $1`, facilityId);
  await prisma.$executeRawUnsafe(`UPDATE "Encounter" SET "linkedEncounterId" = NULL WHERE "facilityId" = $1`, facilityId);
  for (const table of ["Encounter", "Investigation", "Service", "PanelRate", "Panel", "RxTemplate", "PayrollLine", "PayrollRun", "Attendance", "RosterEntry",
    "SupplyLog", "Supply", "WasteBatch", "SmsOutbox", "OtpChallenge"]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "facilityId" = $1`, facilityId);
  }
}

export async function removeQaHospital(facilityId: string) {
  await removeHospitalData(facilityId);
  const users = await prisma.user.findMany({ where: { facilityId }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const patients = await prisma.patient.findMany({ where: { facilityId }, select: { id: true } });
  const patientIds = patients.map((p) => p.id);

  await prisma.housekeepingLog.deleteMany({ where: { facilityId } });
  await prisma.bed.deleteMany({ where: { facilityId } });
  await prisma.abhaTransaction.deleteMany({ where: { facilityId } });
  await prisma.abhaPatient.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.patientShare.deleteMany({ where: { facilityId } });
  await prisma.shareTokenCounter.deleteMany({ where: { facilityId } });
  await prisma.patient.deleteMany({ where: { facilityId } });
  await prisma.staff.deleteMany({ where: { facilityId } });
  await prisma.userRefreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { facilityId } });
  await prisma.auditLog.deleteMany({ where: { facilityId } });
  await prisma.abhaAuditLog.deleteMany({ where: { facilityId } });
  await prisma.hospitalSetting.deleteMany({ where: { facilityId } });
  await prisma.facilityCounter.deleteMany({ where: { facilityId } });
  await prisma.facilityRefreshToken.deleteMany({ where: { facilityId } });
  await prisma.facilityAbdmData.deleteMany({ where: { facilityId } });
  await prisma.facility.deleteMany({ where: { id: facilityId } });
}

/** Signs in through the real login route and returns the cookie header for later calls. */
export async function loginAs(email: string, password: string): Promise<Reply> {
  const reply = await api("POST", "/api/user/admin/login", { body: { email, password } });
  return reply;
}

import "./env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/db.js";
import { api, createQaHospital, loginAs, removeQaHospital, type QaHospital } from "./helpers.js";

describe("Deleting a patient (testing aid)", () => {
  let h: QaHospital;
  let other: QaHospital;
  let cookie = "";
  let otherCookie = "";

  const newPatient = async (name: string) => {
    const r = await api("POST", "/api/patient/create", { cookie, body: { name, phone: "9876500123", dateOfBirth: "1990-05-05" } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.data as { id: string };
  };

  before(async () => {
    h = await createQaHospital();
    other = await createQaHospital();
    cookie = (await loginAs(h.adminEmail, h.adminPassword)).cookie;
    otherCookie = (await loginAs(other.adminEmail, other.adminPassword)).cookie;
  });

  after(async () => {
    await removeQaHospital(h.facilityId);
    await removeQaHospital(other.facilityId);
    await prisma.$disconnect();
  });

  it("needs a login", async () => {
    const p = await newPatient("Delete Nobody");
    assert.equal((await api("DELETE", `/api/patient/${p.id}`)).status, 401);
    assert.equal(await prisma.patient.count({ where: { id: p.id } }), 1);
  });

  it("removes the patient with its ABHA link and transactions", async () => {
    const p = await newPatient("Delete Target");
    await prisma.abhaPatient.create({ data: { patientId: p.id, abhaNumber: `91-${Date.now().toString().slice(-4)}-0000-0000`, abhaAddress: null } });
    await prisma.abhaTransaction.create({
      data: { txnId: `t-${Date.now()}`, patientId: p.id, facilityId: h.facilityId, purpose: "VERIFICATION", status: "PENDING", expiresAt: new Date(Date.now() + 60_000) },
    });

    const r = await api("DELETE", `/api/patient/${p.id}`, { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    assert.equal(await prisma.patient.count({ where: { id: p.id } }), 0);
    assert.equal(await prisma.abhaPatient.count({ where: { patientId: p.id } }), 0);
    assert.equal(await prisma.abhaTransaction.count({ where: { patientId: p.id } }), 0);
    assert.equal((await api("DELETE", `/api/patient/${p.id}`, { cookie })).status, 404);
  });

  it("cannot delete another hospital's patient, or take a malformed id", async () => {
    const p = await newPatient("Delete Foreign");
    assert.equal((await api("DELETE", `/api/patient/${p.id}`, { cookie: otherCookie })).status, 404);
    assert.equal(await prisma.patient.count({ where: { id: p.id } }), 1);
    assert.equal((await api("DELETE", "/api/patient/not-a-uuid", { cookie })).status, 400);
  });
});

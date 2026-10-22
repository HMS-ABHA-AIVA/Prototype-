import "./env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/db.js";
import { api, createQaHospital, loginAs, removeQaHospital, type QaHospital } from "./helpers.js";

// A family often shares one mobile number, so a number must never identify a single patient.
describe("Patients can share a mobile number", () => {
  let h: QaHospital;
  let cookie: string;

  before(async () => {
    h = await createQaHospital();
    cookie = (await loginAs(h.adminEmail, h.adminPassword)).cookie;
  });

  after(async () => {
    await removeQaHospital(h.facilityId);
    await prisma.$disconnect();
  });

  const create = (body: Record<string, unknown>) => api("POST", "/api/patient/create", { cookie, body });

  it("creates several patients with the same mobile number", async () => {
    const a = await create({ name: "Asha Devi", phone: "9876543210", dateOfBirth: "1990-04-02" });
    const b = await create({ name: "Ravi Kumar", phone: "9876543210", dateOfBirth: "2015-08-19" });
    assert.equal(a.status, 201, JSON.stringify(a.json));
    assert.equal(b.status, 201, JSON.stringify(b.json));
    assert.notEqual(a.json.data.id, b.json.data.id);
  });

  it("lets a patient's mobile number be changed to one another patient already has", async () => {
    const a = await create({ name: "Meena Rao", phone: "9000000001", dateOfBirth: "1985-01-12" });
    await create({ name: "Sunil Rao", phone: "9000000002", dateOfBirth: "1983-06-30" });
    const r = await api("PATCH", `/api/patient/${a.json.data.id}`, { cookie, body: { phone: "9000000002" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  it("says exactly what is wrong with a mobile number", async () => {
    const cases: [string, RegExp][] = [
      ["", /Enter the 10-digit mobile number/],
      ["98765abc10", /digits only.*"a" "b" "c"/],
      ["+919876543210", /digits only.*"\+"/],
      ["98765", /has 5 digits, but it needs 10/],
      ["919876543210", /12 digits.*country code 91/],
      ["09876543210", /11 digits.*leading 0/],
      ["98765432101234", /has 14 digits, but it needs exactly 10/],
      ["1234567890", /starts with 1.*6, 7, 8 or 9/],
      ["9999999999", /same digit repeated/],
    ];
    for (const [phone, expected] of cases) {
      const r = await create({ name: "Test Person", phone, dateOfBirth: "1990-01-01" });
      assert.equal(r.status, 400, `${phone} -> ${JSON.stringify(r.json)}`);
      assert.match(String(r.json.message), expected, phone);
    }
  });

  it("registers from an ABHA alone: no name, no date of birth, no mobile", async () => {
    const r = await create({});
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.data.name, "Name pending (from ABHA)");
    assert.equal(r.json.data.dateOfBirth, null);
    assert.equal(r.json.data.phone, "");
  });

  it("still needs a mobile number when a name is given", async () => {
    const r = await create({ name: "Test Person", dateOfBirth: "1990-01-01" });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String(r.json.message), /Enter the 10-digit mobile number/);
  });
});

import bcrypt from "bcrypt";
import type { Database } from "./db.js";
import { BCRYPT_ROUNDS, setLogin } from "./auth/accounts.js";
import { insertBed } from "./modules/beds/beds.repository.js";
import { findBillByEncounter } from "./modules/billing/billing.repository.js";
import { addOrder, addPrescription, addVitals, admitDirect, checkInEr, checkInOpd, saveSoapNote } from "./modules/encounters/encounters.service.js";
import { collectOpdPayment } from "./modules/opd-billing/opd-billing.js";
import { insertPatient } from "./modules/patients/patients.repository.js";

/**
 * Demo data for a hospital (ported from AIVA OSHealth's seed). Every function here runs inside one hospital's scope
 * (db.inFacility) and writes only that hospital's rows. For local development and demonstrations, never for real data:
 * scripts/seed_demo.ts refuses to run in production.
 *
 * Unlike OSHealth's demo, no patient is given an ABHA here: ABHA numbers are created and linked through the M1 screens,
 * against ABDM, so a made-up number can never be mistaken for a real one.
 */

const ACTOR = "seed";
const thisYear = new Date().getFullYear();

/** True when the hospital has no beds and no visits yet (the demo is only added to an unused hospital). */
export async function hospitalIsEmpty(db: Database): Promise<boolean> {
  const row = await db.queryOne<{ n: number }>(
    `SELECT (SELECT count(*) FROM "Bed" WHERE "facilityId" = :fid) + (SELECT count(*) FROM "Encounter" WHERE "facilityId" = :fid) AS n`,
  );
  return !row || row.n === 0;
}

export interface DemoLogins {
  /** Each demo person signs in as <key>@<domain> (renu@..., sunita@...), with this password. */
  domain: string;
  password: string;
}

const DEMO_KEYS = ["renu", "arjun", "sunita", "priya", "mohit", "kavita", "geeta", "anita"];

/** Gives the demo people's logins (in this hospital) a new password, e.g. when the demo is seeded again. Returns how many. */
export async function resetDemoLogins(db: Database, logins: DemoLogins): Promise<number> {
  const hash = await bcrypt.hash(logins.password, BCRYPT_ROUNDS);
  return db.execute(
    `UPDATE "User" SET "passwordHash" = $2, "failedLogins" = 0, "lockedUntil" = NULL, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now()
      WHERE "facilityId" = :fid AND email = ANY($1::text[])`,
    [DEMO_KEYS.map((key) => `${key}@${logins.domain}`), hash],
  );
}

/**
 * A small working hospital: staff of every role, beds, pharmacy stock, panels, example price lists, patients and a few visits
 * (made through the same services the screens use, so the demo obeys the same rules as live data), supplies, bio-medical
 * waste, this week's roster and this month's attendance. Does nothing (returns false) if the hospital already has beds or visits.
 */
export async function seedDemoHospital(db: Database, logins?: DemoLogins): Promise<boolean> {
  if (!(await hospitalIsEmpty(db))) return false;

  await db.execute(
    `UPDATE "Facility" SET "facilityType" = COALESCE("facilityType", 'Nursing Home'), state = COALESCE(state, 'Maharashtra'),
            district = COALESCE(district, 'Pune'), pincode = COALESCE(pincode, '411001'), "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = :fid`,
  );

  const staff: Record<string, string> = {};
  const people: [string, string, string, string, string | null, number | null, number | null][] = [
    // key, name, role, department, HPR id, monthly salary, fee per consult
    ["renu", "Dr. Renu Kapoor", "doctor", "General Medicine", "HPR-88213", null, 400],
    ["arjun", "Dr. Arjun Mehta", "doctor", "Orthopedics", "HPR-77120", null, 500],
    ["sunita", "Sunita Rawat", "nurse", "Ward A", "HPR-55019", 32000, null],
    ["priya", "Priya Nair", "front_office", "Registration", null, 24000, null],
    ["mohit", "Mohit Sharma", "pharmacist", "Pharmacy", null, 30000, null],
    ["kavita", "Kavita Iyer", "biller", "Billing & Insurance", null, 26000, null],
    ["geeta", "Geeta Yadav", "housekeeping", "Housekeeping", null, 18000, null],
    ["anita", "Anita Deshmukh", "lab", "Laboratory & Radiology", null, 28000, null],
  ];
  for (const [key, name, role, department, hprId, salary, fee] of people) {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO "Staff" ("facilityId", name, role, department, "hprId", "employmentType", "monthlySalary", "feePerConsult")
       VALUES (:fid, $1, $2::"StaffRole", $3, $4, $5::"EmploymentType", $6, $7) RETURNING id`,
      [name, role, department, hprId, fee ? "visiting_fee" : "salaried", salary, fee],
    );
    staff[key] = row!.id;
    if (logins) {
      await db.transaction(async (tx) => {
        await setLogin(tx, row!.id, `${key}@${logins.domain}`, logins.password, ACTOR);
        // Demo logins are ready to use; a real login chooses its own password at the first sign-in.
        await tx.execute(`UPDATE "User" SET "mustChangePassword" = false WHERE "facilityId" = :fid AND id = (SELECT "userId" FROM "Staff" WHERE id = $1)`, [row!.id]);
      });
    }
  }

  const beds: [string, string, "vacant" | "dirty" | "cleaning"][] = [
    ["General Ward A", "A-01", "vacant"], ["General Ward A", "A-02", "vacant"], ["General Ward A", "A-03", "dirty"],
    ["General Ward B", "B-01", "cleaning"], ["General Ward B", "B-02", "vacant"], ["ICU", "ICU-01", "vacant"], ["ICU", "ICU-02", "vacant"],
  ];
  const bedIds: Record<string, string> = {};
  for (const [ward, bedNo, status] of beds) bedIds[bedNo] = (await insertBed(db, ward, bedNo, status))!.id;

  const drugs: [string, string, string, number, number, string, number][] = [
    ["Paracetamol 500mg", "PCM-2291", "2027-03-31", 420, 100, "tab", 1.5],
    ["Amoxicillin 500mg", "AMX-1187", "2027-12-31", 60, 80, "cap", 6.2],
    ["Amlodipine 5mg", "AML-3342", "2027-06-30", 210, 50, "tab", 2.1],
    ["ORS Sachet", "ORS-9081", "2027-01-31", 35, 50, "sachet", 18],
    ["Insulin Glargine", "INS-4471", "2027-02-28", 18, 20, "vial", 410],
  ];
  for (const [name, batch, expiry, stock, reorder, unit, mrp] of drugs) {
    const drug = await db.queryOne<{ id: string }>(`INSERT INTO "Drug" ("facilityId", name, "reorderLevel", unit, mrp) VALUES (:fid, $1,$2,$3,$4) RETURNING id`, [name, reorder, unit, mrp]);
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO "DrugBatch" ("facilityId", "drugId", "batchNo", expiry, qty, mrp, "purchaseRate") VALUES (:fid, $1,$2,$3,$4,$5,$6) RETURNING id`,
      [drug!.id, batch, expiry, stock, mrp, Math.round(mrp * 0.7 * 10000) / 10000],
    );
    await db.execute(`INSERT INTO "StockLedger" ("facilityId", "batchId", "drugId", delta, kind, reason, by) VALUES (:fid, $1,$2,$3,'opening','Demo stock',$4)`, [
      row!.id, drug!.id, stock, ACTOR,
    ]);
  }
  await db.execute(
    `INSERT INTO "Supplier" ("facilityId", name, gstin, phone, "drugLicense")
     VALUES (:fid, 'MediSupply Distributors (demo)', '27ABCDE1234F1Z5', '9876500100', 'MH-20B-12345'), (:fid, 'Apex Pharma Traders (demo)', NULL, '9876500101', NULL)`,
  );

  // Example panels so the demo can show special rates. The rates are made up: a real hospital enters the rates it has agreed with each panel.
  const panels: [string, string, string, number, number | null][] = [
    ["CGHS", "CGHS (demo rates)", "government", 0, 350],
    ["ECHS", "ECHS (demo rates)", "government", 0, 300],
    ["DGHS", "DGHS (demo rates)", "government", 20, null],
  ];
  for (const [code, name, category, discountPct, flatFee] of panels) {
    await db.execute(`INSERT INTO "Panel" ("facilityId", code, name, category, "discountPct", "flatFee") VALUES (:fid, $1,$2,$3,$4,$5)`, [code, name, category, discountPct, flatFee]);
  }

  await seedMasters(db);

  const patients: Record<string, string> = {};
  const roster: [string, string, number, "M" | "F", string, string[], string[]][] = [
    // key, name, age, gender, phone, allergies, problems
    ["ramesh", "Ramesh Gupta", 54, "M", "9876500001", ["Penicillin"], ["Type 2 Diabetes", "Hypertension"]],
    ["sunitaD", "Sunita Devi", 32, "F", "9876500002", [], []],
    ["aarav", "Aarav Singh", 7, "M", "9876500003", [], ["Asthma"]],
    ["lakshmi", "Lakshmi Narayan", 68, "F", "9876500004", ["Sulfa drugs"], ["CKD Stage 3"]],
    ["ravi", "Ravi Kumar", 45, "M", "9876500005", [], []],
    ["meena", "Meena Devi", 38, "F", "9876500006", [], []],
  ];
  for (const [key, name, age, gender, phone, allergies, problemList] of roster) {
    patients[key] = (await insertPatient(db, { name, yearOfBirth: thisYear - age, dateOfBirth: null, gender, phone, email: null, allergies, problemList }))!.id;
  }

  // OPD visits go registration -> OPD billing -> queue, so the demo visits have had their consultation fee collected.
  const paidOpd = async (patientId: string, department: string, doctorId: string) => {
    const visit = await checkInOpd(db, { patientId, department, doctorId }, ACTOR);
    await collectOpdPayment(db, { billIds: [(await findBillByEncounter(db, visit.id, "opd_fee"))!.id], mode: "cash" }, { id: null, name: ACTOR }, false);
    return visit;
  };
  const opd1 = await paidOpd(patients.ramesh!, "General Medicine", staff.renu!);
  await addVitals(db, opd1.id, { tempF: 98.4, pulse: 78, bp: "138/86", spo2: 98 }, ACTOR);
  await paidOpd(patients.sunitaD!, "General Medicine", staff.renu!);
  await paidOpd(patients.aarav!, "Orthopedics", staff.arjun!);

  const er1 = await checkInEr(
    db,
    { patientId: patients.ravi!, chiefComplaint: "Sudden onset chest pain and breathlessness", triageLevel: "red", arrivalMode: "ambulance", doctorId: staff.renu! },
    ACTOR,
  );
  await addVitals(db, er1.id, { tempF: 98.9, pulse: 118, bp: "160/100", spo2: 91, rr: 26 }, ACTOR);
  await addOrder(db, er1.id, { type: "lab", name: "Troponin-I" }, ACTOR);

  const er2 = await checkInEr(
    db,
    { patientId: patients.meena!, chiefComplaint: "Fall from stairs, right ankle pain and swelling", triageLevel: "yellow", arrivalMode: "walk_in", doctorId: staff.arjun! },
    ACTOR,
  );
  await saveSoapNote(
    db,
    er2.id,
    {
      subjective: "Slipped on stairs about an hour ago, twisted right ankle. Able to bear partial weight.",
      objective: "Swelling and tenderness over right lateral malleolus. No obvious deformity. Distal pulses intact.",
      assessment: "Suspected right ankle sprain, ? fracture, awaiting X-ray.",
      plan: "X-ray right ankle, RICE, analgesia, review with imaging.",
    },
    ACTOR,
  );
  await addOrder(db, er2.id, { type: "radiology", name: "X-ray Right Ankle (AP/Lateral)" }, ACTOR);
  await addPrescription(db, er2.id, { drugName: "Paracetamol 500mg", dose: "1 tab", frequency: "BD", duration: "3 days" }, ACTOR);

  await admitDirect(db, { patientId: patients.lakshmi!, department: "Nephrology", doctorId: staff.renu!, bedId: bedIds["A-01"]! }, ACTOR);

  await seedOperations(db, staff);
  return true;
}

/**
 * Example price lists: ward bed charges, services, tests with their normal ranges, a few panel rates and shared prescription
 * templates. The prices are illustrative and the ranges typical adult values: a real hospital enters its own tariff (Masters) and
 * its lab's reference ranges. Does nothing (returns false) if the hospital already has services or tests.
 */
export async function seedMasters(db: Database): Promise<boolean> {
  const existing = await db.queryOne<{ n: number }>(
    `SELECT (SELECT count(*) FROM "Service" WHERE "facilityId" = :fid) + (SELECT count(*) FROM "Investigation" WHERE "facilityId" = :fid) AS n`,
  );
  if (existing && existing.n > 0) return false;

  // One daily rate for each ward that has beds. The rates are examples, chosen from the ward's name.
  const wards = (await db.query<{ ward: string }>(`SELECT DISTINCT ward FROM "Bed" WHERE "facilityId" = :fid ORDER BY ward`)).map((r) => r.ward);
  for (const ward of wards) {
    const price = /icu|critical|nicu|ccu/i.test(ward) ? 6000 : /private|deluxe|suite/i.test(ward) ? 3500 : /semi/i.test(ward) ? 2200 : 1500;
    await db.execute(
      `INSERT INTO "Service" ("facilityId", code, name, category, ward, price, "gstPct") VALUES (:fid, $1, $2, 'bed', $3, $4, 0) ON CONFLICT DO NOTHING`,
      [`BED-${ward.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24)}`, `Bed charge per day: ${ward}`, ward, price],
    );
  }

  const services: [string, string, string, number][] = [
    ["NUR-IV", "IV cannulation", "nursing", 250], ["NUR-NEB", "Nebulisation", "nursing", 300], ["NUR-DRESS", "Dressing (minor)", "nursing", 400],
    ["NUR-CATH", "Urinary catheterisation", "nursing", 500], ["NUR-SPL", "Special nursing (per day)", "nursing", 800],
    ["DV-ROUND", "Doctor visit (ward round)", "doctor_visit", 500], ["DV-SPEC", "Specialist visit", "doctor_visit", 800],
    ["PRC-ECG", "ECG", "procedure", 300], ["PRC-SUT", "Suturing (minor)", "procedure", 1500], ["PRC-PLASTER", "Plaster application", "procedure", 1200],
    ["PRC-O2", "Oxygen (per day)", "procedure", 600],
    ["PKG-NVD", "Normal delivery package (3 days)", "package", 25000], ["PKG-LSCS", "Caesarean section package (5 days)", "package", 55000],
  ];
  const serviceIds: Record<string, string> = {};
  for (const [code, name, category, price] of services) {
    serviceIds[code] = (await db.queryOne<{ id: string }>(`INSERT INTO "Service" ("facilityId", code, name, category, price) VALUES (:fid, $1,$2,$3,$4) RETURNING id`, [
      code, name, category, price,
    ]))!.id;
  }

  type Parameter = [string, string | null, number | null, number | null, string | null];
  const tests: [string, string, "lab" | "radiology", string, string | null, number, number, Parameter[]][] = [
    ["CBC", "Complete Blood Count", "lab", "Haematology", "EDTA blood", 350, 4, [
      ["Haemoglobin", "g/dL", 12, 16, null], ["Total leukocyte count", "/uL", 4000, 11000, null], ["Platelet count", "lakh/uL", 1.5, 4.5, null],
      ["RBC count", "million/uL", 4.2, 5.4, null], ["Haematocrit (PCV)", "%", 36, 46, null], ["MCV", "fL", 80, 100, null],
    ]],
    ["LFT", "Liver Function Test", "lab", "Biochemistry", "Serum", 700, 6, [
      ["Bilirubin (total)", "mg/dL", 0.2, 1.2, null], ["SGOT (AST)", "U/L", 5, 40, null], ["SGPT (ALT)", "U/L", 5, 40, null],
      ["Alkaline phosphatase", "U/L", 44, 147, null], ["Total protein", "g/dL", 6, 8.3, null], ["Albumin", "g/dL", 3.5, 5.2, null],
    ]],
    ["KFT", "Kidney Function Test", "lab", "Biochemistry", "Serum", 600, 6, [
      ["Urea", "mg/dL", 15, 45, null], ["Creatinine", "mg/dL", 0.6, 1.3, null], ["Uric acid", "mg/dL", 3.5, 7.2, null],
      ["Sodium", "mmol/L", 135, 145, null], ["Potassium", "mmol/L", 3.5, 5.1, null],
    ]],
    ["LIPID", "Lipid Profile", "lab", "Biochemistry", "Serum (fasting)", 800, 6, [
      ["Total cholesterol", "mg/dL", 0, 200, null], ["HDL cholesterol", "mg/dL", 40, 100, null], ["LDL cholesterol", "mg/dL", 0, 100, null], ["Triglycerides", "mg/dL", 0, 150, null],
    ]],
    ["FBS", "Blood Glucose Fasting", "lab", "Biochemistry", "Fluoride plasma", 80, 2, [["Glucose (fasting)", "mg/dL", 70, 100, null]]],
    ["PPBS", "Blood Glucose Post-Prandial", "lab", "Biochemistry", "Fluoride plasma", 80, 2, [["Glucose (post-prandial)", "mg/dL", 70, 140, null]]],
    ["HBA1C", "HbA1c", "lab", "Biochemistry", "EDTA blood", 550, 6, [["HbA1c", "%", 4, 5.6, null]]],
    ["TSH", "Thyroid Stimulating Hormone (TSH)", "lab", "Immunoassay", "Serum", 450, 8, [["TSH", "uIU/mL", 0.4, 4.2, null]]],
    ["URINE", "Urine R/M", "lab", "Clinical Pathology", "Urine", 150, 2, [
      ["Colour", null, null, null, "Pale yellow"], ["Protein", null, null, null, "Nil"], ["Glucose", null, null, null, "Nil"],
      ["Pus cells", "/hpf", 0, 5, null], ["Epithelial cells", "/hpf", 0, 5, null],
    ]],
    ["TROP-I", "Troponin-I", "lab", "Immunoassay", "Serum", 900, 2, [["Troponin-I", "ng/mL", 0, 0.04, null]]],
    ["XR-CHEST", "X-ray Chest (PA)", "radiology", "Radiology", null, 400, 2, []],
    ["XR-ANKLE", "X-ray Right Ankle (AP/Lateral)", "radiology", "Radiology", null, 500, 2, []],
    ["USG-ABD", "USG Abdomen", "radiology", "Radiology", null, 900, 4, []],
  ];
  const testIds: Record<string, string> = {};
  for (const [code, name, kind, section, sample, price, tat, parameters] of tests) {
    const id = (await db.queryOne<{ id: string }>(
      `INSERT INTO "Investigation" ("facilityId", code, name, kind, section, sample, "tatHours", price) VALUES (:fid, $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, name, kind, section, sample, tat, price],
    ))!.id;
    testIds[code] = id;
    let order = 0;
    for (const [pname, unit, low, high, text] of parameters) {
      await db.execute(
        `INSERT INTO "InvestigationParameter" ("facilityId", "investigationId", name, unit, "refLow", "refHigh", "refText", "sortOrder") VALUES (:fid, $1,$2,$3,$4,$5,$6,$7)`,
        [id, pname, unit, low, high, text, order++],
      );
    }
  }

  // Example critical limits for a few common measures. A pathologist should review these before real use.
  const critical: [string, number | null, number | null][] = [
    ["Haemoglobin", 7, 20], ["Total leukocyte count", 2000, 30000], ["Platelet count", 0.5, 10], ["Creatinine", null, 6], ["Sodium", 120, 160],
    ["Potassium", 2.8, 6.2], ["Glucose (fasting)", 40, 400], ["Glucose (post-prandial)", 40, 500], ["Troponin-I", null, 0.4],
  ];
  for (const [name, low, high] of critical) {
    await db.execute(`UPDATE "InvestigationParameter" SET "criticalLow" = $2, "criticalHigh" = $3 WHERE "facilityId" = :fid AND name = $1`, [name, low, high]);
  }

  // A few made-up CGHS rates for services and tests (when the hospital has a CGHS panel).
  const cghs = (await db.queryOne<{ id: string }>(`SELECT id FROM "Panel" WHERE "facilityId" = :fid AND code = 'CGHS'`))?.id;
  const rates: ["service" | "investigation", string, number][] = [
    ["service", serviceIds["NUR-NEB"]!, 150], ["service", serviceIds["PRC-ECG"]!, 150], ["investigation", testIds["CBC"]!, 200], ["investigation", testIds["LIPID"]!, 400],
  ];
  if (cghs) {
    for (const [kind, id, rate] of rates) {
      await db.execute(`INSERT INTO "PanelItemRate" ("facilityId", "panelId", "itemKind", "itemId", rate) VALUES (:fid, $1,$2,$3,$4)`, [cghs, kind, id, rate]);
    }
  }

  const templates: [string, string, { drugName: string; dose: string; frequency: string; duration: string }[]][] = [
    ["Viral fever", "Viral fever", [{ drugName: "Paracetamol 500mg", dose: "1 tab", frequency: "TDS", duration: "3 days" }]],
    ["Hypertension follow-up", "Hypertension", [{ drugName: "Amlodipine 5mg", dose: "1 tab", frequency: "OD", duration: "30 days" }]],
    ["Mild dehydration", "Acute gastroenteritis", [{ drugName: "ORS Sachet", dose: "1 sachet in 1 L water", frequency: "Sip through the day", duration: "3 days" }]],
  ];
  for (const [name, diagnosis, items] of templates) {
    await db.execute(`INSERT INTO "RxTemplate" ("facilityId", name, "staffId", diagnosis, items) VALUES (:fid, $1, NULL, $2, $3::jsonb)`, [name, diagnosis, JSON.stringify(items)]);
  }
  return true;
}

/** Supplies, bio-medical waste, this week's roster and this month's attendance, all dated relative to today (Indian calendar). */
async function seedOperations(db: Database, staff: Record<string, string>) {
  const supplies: [string, string, string, number, number, string, number][] = [
    // name, category, unit, stock, reorder level, location, days since last restock
    ["Surgical Gloves (Sterile, size 7)", "Surgical Consumables", "pair", 340, 150, "Central Store", 18],
    ["IV Cannula 20G", "Surgical Consumables", "pc", 210, 100, "Central Store", 15],
    ["Suture Kit (3-0 Vicryl)", "Surgical Consumables", "kit", 28, 30, "OT Store", 23],
    ["N95 Masks", "PPE", "pc", 480, 200, "Central Store", 14],
    ["Disposable Gowns", "PPE", "pc", 65, 100, "Central Store", 28],
    ["Face Shields", "PPE", "pc", 40, 50, "Central Store", 36],
    ["Bedsheets (Single)", "Linen & Housekeeping", "pc", 150, 80, "Laundry Store", 21],
    ["Hand Sanitizer 500ml", "Linen & Housekeeping", "bottle", 90, 60, "Central Store", 19],
    ["Infusion Pump", "Equipment", "unit", 6, 4, "Biomedical Store", 120],
    ["Pulse Oximeter (handheld)", "Equipment", "unit", 9, 6, "Biomedical Store", 80],
    ["A4 Printer Paper", "Stationery & Admin", "ream", 22, 20, "Admin Store", 32],
    ["Blood Collection Tubes (EDTA)", "Diagnostic Consumables", "pc", 300, 150, "Lab Store", 16],
    ["Glucometer Strips", "Diagnostic Consumables", "strip", 45, 100, "Lab Store", 44],
  ];
  for (const [name, category, unit, stock, reorder, location, daysAgo] of supplies) {
    await db.execute(
      `INSERT INTO "Supply" ("facilityId", name, category, unit, stock, "reorderLevel", location, "lastRestockedAt")
       VALUES (:fid, $1,$2,$3,$4,$5,$6, now() - make_interval(days => $7))`,
      [name, category, unit, stock, reorder, location, daysAgo],
    );
  }

  const waste: [string, string, number, string, string, string | null, string | null][] = [
    // category, department, kg, stage, segregated by, storage location, pre-treatment method
    ["yellow", "General Ward A", 4.2, "segregated", "Geeta Yadav", null, null],
    ["red", "OT", 2.8, "stored", "Geeta Yadav", "Central BMW Storage Room", null],
    ["white", "General Ward B", 1.1, "pretreated", "Sunita Rawat", "Central BMW Storage Room", "Autoclave / chemical disinfection"],
    ["blue", "Pharmacy", 0.9, "stored", "Geeta Yadav", "Central BMW Storage Room", null],
  ];
  for (const [category, department, kg, stage, by, location, method] of waste) {
    await db.execute(
      `INSERT INTO "WasteBatch" ("facilityId", category, department, "weightKg", stage, "segregatedBy", "segregatedAt", "storageLocation", "storedAt",
                                 "pretreatmentMethod", "pretreatedAt", "pretreatedBy")
       VALUES (:fid, $1,$2,$3,$4,$5, now() - interval '5 hours', $6::text, CASE WHEN $6::text IS NULL THEN NULL ELSE now() - interval '4 hours' END,
               $7::text, CASE WHEN $7::text IS NULL THEN NULL ELSE now() - interval '2 hours' END, CASE WHEN $7::text IS NULL THEN NULL ELSE $5 END)`,
      [category, department, kg, stage, by, location, method],
    );
  }

  // This week's roster (Monday = day 0). Ward A has no night cover on Wed/Thu on purpose: a gap for the roster screen to show.
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
  const roster: [string, number, string, string][] = [
    ["sunita", 0, "morning", "Ward A"], ["sunita", 1, "morning", "Ward A"], ["sunita", 2, "morning", "Ward A"],
    ["sunita", 2, "evening", "Ward A"], ["sunita", 3, "morning", "Ward A"],
    ["geeta", 1, "morning", "Housekeeping"], ["geeta", 2, "morning", "Housekeeping"], ["geeta", 3, "evening", "Housekeeping"],
    ["priya", 1, "morning", "Registration"], ["priya", 2, "morning", "Registration"],
  ];
  for (const [key, day, shift, department] of roster) {
    await db.execute(
      `INSERT INTO "RosterEntry" ("facilityId", "staffId", date, shift, department) VALUES (:fid, $1, date_trunc('week', ${today})::date + $2::int, $3, $4)`,
      [staff[key], day, shift, department],
    );
  }

  // Attendance for the first days of this month, including a double shift (two shifts on one date).
  const attendance: [string, number, string, string][] = [
    ["sunita", 0, "morning", "present"], ["sunita", 1, "morning", "present"], ["sunita", 1, "evening", "present"], ["sunita", 2, "morning", "leave"],
    ["priya", 0, "morning", "present"], ["priya", 1, "morning", "half_day"],
  ];
  for (const [key, day, shift, status] of attendance) {
    await db.execute(
      `INSERT INTO "Attendance" ("facilityId", "staffId", date, shift, status) VALUES (:fid, $1, date_trunc('month', ${today})::date + $2::int, $3, $4)`,
      [staff[key], day, shift, status],
    );
  }
}

import "dotenv/config";
import { randomBytes } from "crypto";
import { appendFileSync } from "fs";
import bcrypt from "bcrypt";
import { prisma } from "../src/config/db.js";
import { passwordProblem } from "../src/hospital/auth/accounts.js";
import { createDatabase } from "../src/hospital/db.js";
import { resetDemoLogins, seedDemoHospital } from "../src/hospital/seed.js";

// Creates a demo facility + staff login for LOCAL development only.
//  - Refuses to run against production.
//  - Never uses a fixed password: pass SEED_PASSWORD, or one is generated and written to the
//    git-ignored backend/.local-credentials.txt (it is not printed).
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo accounts when NODE_ENV=production.");
  process.exit(1);
}

const FACILITY_EMAIL = process.env.SEED_FACILITY_EMAIL ?? "admin@hospital.com";
const STAFF_EMAIL = process.env.SEED_STAFF_EMAIL ?? "admin@hospital.com";

async function main() {
  console.log("Seeding demo facility and staff...");

  const generated = !process.env.SEED_PASSWORD;
  // (A generated password always ends in a letter and a digit, as the password rules ask.)
  const password = process.env.SEED_PASSWORD ?? `${randomBytes(12).toString("base64url")}k7`;
  const problem = passwordProblem(`renu@${STAFF_EMAIL.split("@")[1] ?? "hospital.com"}`, password) ?? passwordProblem(STAFF_EMAIL, password);
  if (problem) {
    throw new Error(`SEED_PASSWORD: ${problem}`);
  }

  const facilityPassword = await bcrypt.hash(password, 10);
  const staffPassword = await bcrypt.hash(password, 12);

  const facility = await prisma.facility.upsert({
    where: { email: FACILITY_EMAIL },
    update: {
      passwordHash: facilityPassword,
    },
    create: {
      name: "City General Hospital",
      email: FACILITY_EMAIL,
      hfrId: "IN2410001234",
      passwordHash: facilityPassword,
    },
  });
  console.log("✔ Facility ready:", facility.email, "(ID:", facility.id, ")");

  const staffAdmin = await prisma.user.upsert({
    where: { email: STAFF_EMAIL },
    update: {
      passwordHash: staffPassword,
      facilityId: facility.id,
    },
    create: {
      name: "Asha Verma",
      email: STAFF_EMAIL,
      facilityId: facility.id,
      passwordHash: staffPassword,
    },
  });
  console.log("✔ Staff admin ready:", staffAdmin.email, "(ID:", staffAdmin.id, ")");

  // The hospital modules know people by their staff record (role, department, pay).
  await prisma.staff.upsert({
    where: { userId: staffAdmin.id },
    update: {},
    create: { facilityId: facility.id, userId: staffAdmin.id, name: staffAdmin.name, role: "admin", department: "Administration" },
  });

  // A working hospital for the OPD, IPD, pharmacy, lab, billing ... screens: staff of every role (each with a login,
  // <name>@<the staff e-mail's domain>, same password), beds, stock, price lists, patients and a few visits. Only once.
  const db = createDatabase(process.env.DATABASE_URL!);
  try {
    const domain = STAFF_EMAIL.split("@")[1] ?? "hospital.com";
    const added = await db.inFacility(facility.id, () => seedDemoHospital(db, { domain, password }));
    if (added) {
      console.log(`✔ Demo hospital data added (logins renu@${domain}, sunita@${domain}, priya@${domain} ...)`);
    } else {
      const reset = await db.inFacility(facility.id, () => resetDemoLogins(db, { domain, password }));
      console.log(`✔ Hospital already has beds or visits: demo data not added again (${reset} demo login(s) given the new password)`);
    }
  } finally {
    await db.close();
  }

  if (generated) {
    appendFileSync(
      new URL("../.local-credentials.txt", import.meta.url),
      `${new Date().toISOString()}  facility ${FACILITY_EMAIL} / staff ${STAFF_EMAIL}  password: ${password}\n`,
    );
    console.log("A password was generated and saved to backend/.local-credentials.txt (git-ignored).");
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

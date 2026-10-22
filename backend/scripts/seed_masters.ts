import "dotenv/config";
import { prisma } from "../src/config/db.js";
import { createDatabase } from "../src/hospital/db.js";
import { seedMasters } from "../src/hospital/seed.js";

// npm run seed:masters [HFR ID] — adds the EXAMPLE price lists (ward bed charges, services, tests with normal ranges, prescription
// templates) to a hospital that has none yet, so its bills have something to price from. The prices are illustrative: replace them
// under Masters. Without an HFR ID it works on the only hospital (and refuses when there are several).
const hfrId = process.argv[2];
const facilities = await prisma.facility.findMany({ where: hfrId ? { hfrId } : {}, select: { id: true, name: true, hfrId: true }, take: 2 });
await prisma.$disconnect();

if (facilities.length !== 1) {
  console.error(hfrId ? `No hospital has the HFR ID "${hfrId}".` : facilities.length ? "There are several hospitals: give the HFR ID of one." : "There is no hospital yet.");
  process.exitCode = 1;
} else {
  const facility = facilities[0]!;
  const db = createDatabase(process.env.DATABASE_URL!);
  try {
    const added = await db.inFacility(facility.id, () => seedMasters(db));
    console.log(added ? `Example price lists added to ${facility.name} (${facility.hfrId}): change them under Masters.` : `${facility.name} already has price lists: nothing added.`);
  } finally {
    await db.close();
  }
}

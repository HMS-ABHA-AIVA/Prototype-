import { prisma } from "../../config/db.js";

// Start of today in Indian time, as a Date.
const startOfToday = () => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}T00:00:00+05:30`);

/** Counts for the staff dashboard. Numbers and action names only: no patient data. */
export const getDashboardService = async (facilityId: string) => {
  const now = new Date();

  const [totalPatients, abhaLinked, registeredToday, pendingShares, recent] = await Promise.all([
    prisma.patient.count({ where: { facilityId } }),
    prisma.abhaPatient.count({ where: { patient: { facilityId } } }),
    prisma.patient.count({ where: { facilityId, createdAt: { gte: startOfToday() } } }),
    prisma.patientShare.count({ where: { facilityId, expiresAt: { gt: now } } }),
    prisma.abhaAuditLog.findMany({
      where: { facilityId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, action: true, outcome: true, errorCode: true, createdAt: true },
    }),
  ]);

  return {
    totalPatients,
    abhaLinked,
    withoutAbha: Math.max(totalPatients - abhaLinked, 0),
    registeredToday,
    pendingShares,
    recentActivity: recent,
  };
};

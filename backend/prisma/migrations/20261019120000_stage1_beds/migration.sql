-- Stage 1 of merging the OSHealth prototype: beds and the housekeeping log. Additive only.

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('occupied', 'dirty', 'cleaning', 'vacant', 'reserved');

-- CreateEnum
CREATE TYPE "HousekeepingAction" AS ENUM ('discharge_release', 'cleaning_started', 'cleaning_completed');

-- CreateTable
CREATE TABLE "Bed" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "ward" TEXT NOT NULL,
    "bedNo" TEXT NOT NULL,
    "status" "BedStatus" NOT NULL DEFAULT 'vacant',
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patientId" TEXT,
    "encounterId" TEXT,
    "reservedPatientId" TEXT,
    "reservedFor" TEXT,
    "reservedUntil" TIMESTAMP(3),
    "reservedNote" TEXT,

    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingLog" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "action" "HousekeepingAction" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,

    CONSTRAINT "HousekeepingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bed_facilityId_status_idx" ON "Bed"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_facilityId_ward_bedNo_key" ON "Bed"("facilityId", "ward", "bedNo");

-- CreateIndex
CREATE INDEX "HousekeepingLog_facilityId_at_idx" ON "HousekeepingLog"("facilityId", "at");

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_reservedPatientId_fkey" FOREIGN KEY ("reservedPatientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingLog" ADD CONSTRAINT "HousekeepingLog_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

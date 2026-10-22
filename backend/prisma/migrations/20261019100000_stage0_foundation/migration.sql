-- Stage 0 of merging the OSHealth prototype: roles, staff, hospital settings, general audit log, running numbers, MRNs.
-- Additive only: nothing existing is changed or removed. Existing logins become admins (what they effectively were).

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('front_office', 'doctor', 'nurse', 'pharmacist', 'biller', 'housekeeping', 'lab', 'admin');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('salaried', 'visiting_fee');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" "StaffRole" NOT NULL DEFAULT 'admin',
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN "hipId" TEXT,
ADD COLUMN "facilityType" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "state" TEXT,
ADD COLUMN "district" TEXT,
ADD COLUMN "pincode" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "latitude" DECIMAL(9,6),
ADD COLUMN "longitude" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN "mrn" TEXT,
ADD COLUMN "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "problemList" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "department" TEXT NOT NULL,
    "hprId" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'salaried',
    "monthlySalary" DECIMAL(12,2),
    "feePerConsult" DECIMAL(12,2),
    "consultationFee" DECIMAL(12,2),
    "bankAccountLast4" TEXT,
    "dateOfJoining" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalSetting" (
    "facilityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalSetting_pkey" PRIMARY KEY ("facilityId","key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityCounter" (
    "facilityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "FacilityCounter_pkey" PRIMARY KEY ("facilityId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_userId_key" ON "Staff"("userId");

-- CreateIndex
CREATE INDEX "Staff_facilityId_role_idx" ON "Staff"("facilityId", "role");

-- CreateIndex
CREATE INDEX "AuditLog_facilityId_at_idx" ON "AuditLog"("facilityId", "at");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every existing login appears in the staff list as an administrator.
INSERT INTO "Staff" ("id", "facilityId", "userId", "name", "role", "department", "updatedAt")
SELECT gen_random_uuid()::text, u."facilityId", u."id", u."name", 'admin', 'Administration', CURRENT_TIMESTAMP FROM "User" u;

-- Medical record numbers for the patients that already exist: MRN-10001, MRN-10002 ... per hospital, oldest first.
UPDATE "Patient" p SET "mrn" = 'MRN-' || (10000 + r.rn)
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "facilityId" ORDER BY "createdAt", "id") AS rn FROM "Patient") r
WHERE p."id" = r."id";

INSERT INTO "FacilityCounter" ("facilityId", "key", "value")
SELECT "facilityId", 'mrn', 10000 + COUNT(*) FROM "Patient" GROUP BY "facilityId";

-- CreateIndex (after the backfill, so every existing row already has its number)
CREATE UNIQUE INDEX "Patient_facilityId_mrn_key" ON "Patient"("facilityId", "mrn");

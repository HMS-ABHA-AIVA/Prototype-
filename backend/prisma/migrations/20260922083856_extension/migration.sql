/*
  Warnings:

  - You are about to drop the `abhaPatient` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AbhaTransactionPurpose" AS ENUM ('ENROLLMENT', 'VERIFICATION');

-- CreateEnum
CREATE TYPE "AbhaTransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- DropForeignKey
ALTER TABLE "abhaPatient" DROP CONSTRAINT "abhaPatient_patientId_fkey";

-- DropTable
DROP TABLE "abhaPatient";

-- CreateTable
CREATE TABLE "AbhaPatient" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "abhaNumber" TEXT NOT NULL,
    "abhaAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbhaPatient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbhaTransaction" (
    "id" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "purpose" "AbhaTransactionPurpose" NOT NULL,
    "status" "AbhaTransactionStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbhaTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AbhaPatient_patientId_key" ON "AbhaPatient"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "AbhaPatient_abhaNumber_key" ON "AbhaPatient"("abhaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AbhaTransaction_txnId_key" ON "AbhaTransaction"("txnId");

-- CreateIndex
CREATE INDEX "AbhaTransaction_patientId_idx" ON "AbhaTransaction"("patientId");

-- CreateIndex
CREATE INDEX "AbhaTransaction_facilityId_idx" ON "AbhaTransaction"("facilityId");

-- AddForeignKey
ALTER TABLE "AbhaPatient" ADD CONSTRAINT "AbhaPatient_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbhaTransaction" ADD CONSTRAINT "AbhaTransaction_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbhaTransaction" ADD CONSTRAINT "AbhaTransaction_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

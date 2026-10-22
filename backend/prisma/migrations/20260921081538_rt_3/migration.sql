/*
  Warnings:

  - A unique constraint covering the columns `[facilityId,environment]` on the table `FacilityAbdmData` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `environment` to the `FacilityAbdmData` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AbdmEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- DropIndex
DROP INDEX "FacilityAbdmData_facilityId_key";

-- AlterTable
ALTER TABLE "FacilityAbdmData" ADD COLUMN     "environment" "AbdmEnvironment" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "FacilityAbdmData_facilityId_environment_key" ON "FacilityAbdmData"("facilityId", "environment");

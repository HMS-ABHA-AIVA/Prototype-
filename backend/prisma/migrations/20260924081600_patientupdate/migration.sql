/*
  Warnings:

  - Added the required column `phone` to the `Patient` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Patient_phone_idx" ON "Patient"("phone");

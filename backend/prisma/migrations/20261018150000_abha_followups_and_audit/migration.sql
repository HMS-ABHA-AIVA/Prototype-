-- AlterTable
ALTER TABLE "AbhaTransaction" ADD COLUMN     "enrolTxnId" TEXT,
ADD COLUMN     "mobileOtpTxnId" TEXT,
ADD COLUMN     "mobileVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AbhaAuditLog" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "userId" TEXT,
    "patientId" TEXT,
    "transactionId" TEXT,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "errorCode" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbhaAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbhaAuditLog_facilityId_createdAt_idx" ON "AbhaAuditLog"("facilityId", "createdAt");

-- CreateIndex
CREATE INDEX "AbhaAuditLog_patientId_idx" ON "AbhaAuditLog"("patientId");

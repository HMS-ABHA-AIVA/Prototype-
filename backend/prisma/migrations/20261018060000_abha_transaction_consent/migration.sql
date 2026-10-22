-- AlterTable
ALTER TABLE "AbhaTransaction" ADD COLUMN     "consentAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "consentCode" TEXT,
ADD COLUMN     "consentVersion" TEXT;

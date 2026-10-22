-- AlterEnum
ALTER TYPE "AbhaTransactionPurpose" ADD VALUE 'PROFILE_UPDATE';

-- AlterTable
ALTER TABLE "AbhaTransaction" ADD COLUMN     "consentLanguage" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "address" TEXT,
ADD COLUMN     "districtName" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "stateName" TEXT;

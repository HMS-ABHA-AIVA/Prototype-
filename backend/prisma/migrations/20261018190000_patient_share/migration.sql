-- CreateTable
CREATE TABLE "PatientShare" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "environment" "AbdmEnvironment" NOT NULL,
    "counterCode" TEXT NOT NULL,
    "tokenNumber" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "abhaNumber" TEXT,
    "abhaAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "dayOfBirth" INTEGER,
    "monthOfBirth" INTEGER,
    "yearOfBirth" INTEGER NOT NULL,
    "addressLine" TEXT,
    "district" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "phone" TEXT,
    "matchedPatientId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareTokenCounter" (
    "facilityId" TEXT NOT NULL,
    "counterCode" TEXT NOT NULL,
    "tokenDate" DATE NOT NULL,
    "lastToken" INTEGER NOT NULL,

    CONSTRAINT "ShareTokenCounter_pkey" PRIMARY KEY ("facilityId","counterCode","tokenDate")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientShare_requestId_key" ON "PatientShare"("requestId");

-- CreateIndex
CREATE INDEX "PatientShare_facilityId_expiresAt_idx" ON "PatientShare"("facilityId", "expiresAt");

-- CreateIndex
CREATE INDEX "PatientShare_facilityId_counterCode_abhaAddress_idx" ON "PatientShare"("facilityId", "counterCode", "abhaAddress");

-- AddForeignKey
ALTER TABLE "PatientShare" ADD CONSTRAINT "PatientShare_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

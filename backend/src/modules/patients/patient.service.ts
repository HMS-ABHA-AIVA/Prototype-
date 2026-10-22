import { prisma } from "../../config/db.js";
import { ApiError } from "../../common/errors/appError.js";

// DATE column <-> "YYYY-MM-DD" (no time zone shifts)
const toDateOnly = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

export const createPatientService = async (name: string,phone: string,email: string | undefined,facilityId: string,dateOfBirth?: string,gender?: "M" | "F" | "O") => {
    // A mobile number is not unique: one family often shares a single phone.
    const patient = await prisma.patient.create({
        data: {
            name,
            phone,
            email : email ?? null,
            dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null,
            gender: gender ?? null,
            facilityId,
        }
    });

    return { ...patient, dateOfBirth: toDateOnly(patient.dateOfBirth) };
};
/** Removes a patient, their ABHA link and their ABHA transactions (testing aid). The deletion is logged as a security event. */
export const deletePatientService = async (patientId: string, facilityId: string) => {
    await prisma.$transaction(async (tx) => {
        const patient = await tx.patient.findFirst({ where: { id: patientId, facilityId }, select: { id: true } });
        if (!patient) throw new ApiError(404, "Patient not found", [], "PATIENT_NOT_FOUND");

        // A patient with hospital records (visits, bills, receipts, tests, pharmacy sales) is a medical record and is never deleted.
        const [visits, payments, labInvoices, sales] = await Promise.all([
            tx.encounter.count({ where: { patientId } }),
            tx.opdPayment.count({ where: { patientId } }),
            tx.labInvoice.count({ where: { patientId } }),
            tx.pharmacySale.count({ where: { patientId } }),
        ]);
        if (visits + payments + labInvoices + sales > 0) {
            throw new ApiError(409, "This patient has visits, bills or other hospital records, so the record cannot be deleted.", [], "PATIENT_HAS_RECORDS");
        }
        await tx.bed.updateMany({ where: { reservedPatientId: patientId }, data: { reservedPatientId: null } });

        await tx.abhaTransaction.deleteMany({ where: { patientId } });
        await tx.abhaPatient.deleteMany({ where: { patientId } });
        await tx.patient.delete({ where: { id: patientId } });
    });
};

export const getAllPatientsService = async (facilityId: string, limit = 500, page = 1) => {
    const patients = await prisma.patient.findMany({
        where: {
            facilityId,
        },
        take: limit,
        skip: (page - 1) * limit,
        include: {
            abha: true,
        },
        orderBy: {
            createdAt: "desc",
        },
    });

    return patients.map((patient) => ({
    id: patient.id,
    abhaUpdateNote: patient.abhaUpdateNote,
    name: patient.name,
    phone: patient.phone,
    email: patient.email,
    dateOfBirth: toDateOnly(patient.dateOfBirth),
    gender: patient.gender,
    address: patient.address,
    stateName: patient.stateName,
    districtName: patient.districtName,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
    abha: patient.abha
        ? {
              abhaNumber: patient.abha.abhaNumber,
              abhaAddress: patient.abha.abhaAddress,
          }
        : null,
}));
};

export const getPatientTransactionsService = async (patientId: string,facilityId: string) => {
  // Make sure patient belongs to this facility
  const patient = await prisma.patient.findFirst({
    where: {
      id: patientId,
      facilityId,
    },
  });

  if (!patient) {
    throw new ApiError(404, "Patient not found");
  }

  const transactions = await prisma.abhaTransaction.findMany({
    where: {
      patientId,
      facilityId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return transactions;
};
export const updatePatientService = async (
    patientId: string,
    facilityId: string,
    changes: { phone?: string | undefined; email?: string | undefined; address?: string | undefined; stateName?: string | undefined; districtName?: string | undefined },
) => {
    const patient = await prisma.patient.findFirst({ where: { id: patientId, facilityId } });

    if (!patient) {
        throw new ApiError(404, "Patient not found", [], "PATIENT_NOT_FOUND");
    }

    // Only the fields that were sent are touched; "" clears an optional text field.
    const data: { phone?: string; email?: string | null; address?: string | null; stateName?: string | null; districtName?: string | null } = {};
    if (changes.phone !== undefined) data.phone = changes.phone;
    if (changes.email !== undefined) data.email = changes.email === "" ? null : changes.email;
    if (changes.address !== undefined) data.address = changes.address === "" ? null : changes.address;
    if (changes.stateName !== undefined) data.stateName = changes.stateName === "" ? null : changes.stateName;
    if (changes.districtName !== undefined) data.districtName = changes.districtName === "" ? null : changes.districtName;

    const updated = await prisma.patient.update({ where: { id: patientId }, data });

    return { ...updated, dateOfBirth: toDateOnly(updated.dateOfBirth) };
};

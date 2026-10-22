import type { Queryable } from "../../db.js";
import type { Settings } from "../masters/settings.js";
import { istDate, priceLine } from "./gst.js";

/**
 * The medicine lines a visit's bill carries: what the pharmacy handed over for it. A dispense's line is entered at its taxable value (MRP less GST), so
 * with GST added on the bill it comes back to the MRP the patient is charged. A medicine marked dispensed before dispensing was recorded (older records)
 * is priced at the stock list's MRP, or the hospital's price for an unlisted medicine.
 */
export interface MedicineLine {
  label: string;
  rate: number;
  gstPct: number;
  date: string;
}

export async function medicineLines(db: Queryable, encounterId: string, settings: Settings): Promise<MedicineLine[]> {
  const sold = await db.query<{ drugName: string; qty: number; taxable: number; gstPct: number; soldAt: string }>(
    `SELECT i."drugName", i.qty, i.taxable::float8 AS taxable, i."gstPct"::float8 AS "gstPct", s."soldAt"
       FROM "PharmacySaleItem" i JOIN "PharmacySale" s ON s.id = i."saleId"
      WHERE s."facilityId" = :fid AND s."encounterId" = $1 AND s.kind = 'encounter' AND s.status = 'paid' ORDER BY s."soldAt", i."drugName"`,
    [encounterId],
  );
  const lines: MedicineLine[] = sold.map((i) => ({ label: `Pharmacy: ${i.drugName} x ${i.qty}`, rate: i.taxable, gstPct: i.gstPct, date: istDate(new Date(i.soldAt)) }));

  const older = await db.query<{ drugName: string; createdAt: string; mrp: number | null; gstPct: number | null }>(
    `SELECT p."drugName", p."createdAt", d.mrp::float8 AS mrp, d."gstPct"::float8 AS "gstPct"
       FROM "Prescription" p LEFT JOIN "Drug" d ON d."facilityId" = :fid AND lower(d.name) = lower(p."drugName")
      WHERE p."facilityId" = :fid AND p."encounterId" = $1 AND p.dispensed
        AND NOT EXISTS (SELECT 1 FROM "PharmacySaleItem" i WHERE i."facilityId" = :fid AND i."prescriptionId" = p.id)
      ORDER BY p."createdAt"`,
    [encounterId],
  );
  for (const rx of older) {
    const gst = rx.gstPct ?? settings.medicineGstPct;
    lines.push({
      label: `Pharmacy: ${rx.drugName}`,
      rate: priceLine(1, rx.mrp ?? settings.unlistedMedicinePrice, gst).taxable,
      gstPct: gst,
      date: istDate(new Date(rx.createdAt)),
    });
  }
  return lines;
}

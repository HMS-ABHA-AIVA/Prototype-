import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hospitals are kept apart by facilityId. Every SQL statement in the hospital modules that names a hospital table must carry the
 * :fid placeholder (filled from the signed-in hospital by src/hospital/db.ts), or be marked as deliberately crossing hospitals
 * ("cross-facility: <reason>") because it looks a login up before its hospital is known. The platform console works across hospitals
 * by design and is exempt. This test reads the sources, so a forgotten filter fails here before it can ever leak data.
 */
const ROOT = fileURLToPath(new URL("../../src/hospital", import.meta.url));
const HOSPITAL_TABLES = [
  "Patient", "Staff", "Bed", "HousekeepingLog", "AuditLog", "HospitalSetting", "Encounter", "Vital", "Prescription", "ClinicalOrder", "Drug", "Bill",
  "BillItem", "Supply", "SupplyLog", "WasteBatch", "Attendance", "RosterEntry", "PayrollRun", "PayrollLine", "OpdPayment", "Panel", "PanelRate", "Service",
  "Investigation", "InvestigationParameter", "PanelItemRate", "RxTemplate", "BedStay", "IpdCharge", "IpdPayment", "Birth", "EncounterDocument", "SmsOutbox",
  "OtpChallenge", "Supplier", "Purchase", "DrugBatch", "PurchaseItem", "StockLedger", "PharmacySale", "PharmacySaleItem", "MedicationSchedule", "MedicationDose",
  "LabInvoice", "LabInvoiceItem", "OrderResult", "ReportAmendment", "OrderAttachment", "User", "Facility",
];
const EXEMPT_FILES = [join("modules", "platform", "platform.ts")];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** The SQL strings of a source file: template literals and quoted strings that contain a quoted table name. */
function sqlStrings(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
    const text = m[1] ?? m[2] ?? "";
    if (HOSPITAL_TABLES.some((t) => text.includes(`"${t}"`)) && /\b(SELECT|INSERT|UPDATE|DELETE|FROM)\b/.test(text)) out.push(text);
  }
  return out;
}

describe("hospital SQL is scoped to one hospital", () => {
  it("every statement on a hospital table carries :fid (or is explicitly marked as crossing hospitals)", () => {
    const problems: string[] = [];
    for (const file of files(ROOT)) {
      const relative = file.slice(ROOT.length + 1);
      if (EXEMPT_FILES.includes(relative)) continue;
      for (const sql of sqlStrings(readFileSync(file, "utf8"))) {
        // "fragment:" marks a reusable piece (a column list, a FROM clause) whose every caller adds the :fid condition.
        if (sql.includes(":fid") || sql.includes("cross-facility:") || sql.includes("fragment:")) continue;
        problems.push(`${relative}: ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    assert.deepEqual(problems, [], `statements without :fid:\n${problems.join("\n")}`);
  });

  it("finds the statements it is meant to check", () => {
    const count = files(ROOT).reduce((n, f) => n + sqlStrings(readFileSync(f, "utf8")).length, 0);
    assert.ok(count > 300, `only ${count} statements found: the scan is not reading the sources`);
  });
});

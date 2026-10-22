<!-- From AIVA OSHealth, adapted to the merged application. -->
# Laboratory and radiology

Screen: Lab & Radiology (lab technician, nurse, doctor, administrator; front office and billing see the invoice tabs). API: `/api/v1/lab`.

## A test as a piece of work

A test ordered on a visit (OPD, emergency or inpatient) is an **order**. Phase 3 turns it into work with steps, each recording who did it and when:

| | Lab test | Radiology study |
|---|---|---|
| 1 | **Ordered** | **Ordered** |
| 2 | **Sample collected**: a sample number `LS-n` is issued (a nurse, doctor or technician may collect) | **Study started**: an accession number `RD-n` is issued |
| 3 | **Results entered** against the test's list of measures | **Report written**: findings and impression, with images or PDFs attached |
| 4 | **Signed**: the report is released | **Signed** |

- A bad sample (haemolysed, wrong tube) is **rejected** with a reason: the order goes back to "ordered" and a new sample number is issued when it is collected again.
- A test that will not be done is **cancelled** with a reason, and is **not charged**. It can be cancelled only before results are entered, and (for a test on a visit) only until the visit's bill has been raised; after that the billing counter corrects the bill.
- The number `LS-n` / `RD-n` is the only label for now (no barcode printing).

## Results, ranges and flags

Each lab test in Masters > Tests lists what it measures, with the unit, the **normal range** and optional **critical limits**. When a value is entered:

- A number is checked: **L** (below the normal range), **H** (above), **LL / HH** (beyond a critical limit). The ends of the range are normal.
- A text result ("Nil", "Positive", "<0.5") has no number to check, so it is flagged only if the person ticks **Abn.**
- The definition (unit, range, limits) is **copied into the result** when it is entered, so a report never changes if the test's ranges are edited later.
- A test with no list of measures (or one typed in free text) takes rows the technician adds.
- Results can be saved again until the report is signed. Signing needs a value for every measure on the test (write "-" for one not done).
- The example critical limits that come with the demo data (haemoglobin, potassium and so on) are textbook figures: **the hospital's pathologist should review them** before real use.

## Signing, verification and amendments

- **Who signs**: lab technicians, doctors (a radiologist or pathologist) and administrators.
- **Second-person verification** is a hospital setting (Masters > Hospital settings, off by default). When it is on, a report cannot be signed by the person who entered the results (a technician enters, a pathologist signs).
- A **signed report is never overwritten**. A correction is an **amendment**: it needs a reason, keeps the earlier values and who signed them, reopens the report, and it has to be signed again. The printed report is marked "Amended" with the reasons.
- Until a report is signed, **doctors and nurses see only its progress**, not the values, and a radiology image is visible only to the lab.

## Critical values

A result beyond a critical limit marks the report **critical**. It shows on the lab worklist, on the doctor's dashboard ("critical results to acknowledge"), and on the visit's order list. A doctor opens the report and confirms **"I have seen the critical value"**: who and when are recorded. The lab can see which are still unacknowledged.

## The report

A print-ready page with the hospital heading, patient and sample details, each result against its normal range with the flag, remarks, who entered it and who signed it (with their registration number if recorded), and a footer. Doctors open it from the visit's order list; the lab and administrators from the worklist. A patient's signed reports are listed at `GET /lab/patients/:id/reports`.

## Tests for a patient without a visit (lab-desk invoices)

A **registered** patient who has come only for tests (or with an outside referral) is handled at the lab desk: pick the patient and the tests, the screen shows the **exact amount** (the standard price, or a panel's rate, less a discount %, plus GST), payment is taken (cash / UPI / card / other), and an invoice **`LB-n`** is printed. The tests join the same worklist. A patient who is not yet registered is registered at the front office first. Rules:

- Tests ordered on a visit are billed with that visit, not here.
- An invoice can be **cancelled** (billing counter, administrators; reason needed) only before any sample is collected. After that, the tests are handled one by one.
- A panel that needs a card number asks for it, as it does on a visit.

## Management figures

For a period (by the date the test was ordered), lab and radiology separately or together:

- Tests ordered, reported, cancelled, **pending and overdue** (past the hours the test promises, counted from the sample or order), critical, and amended after release.
- By section and by test: counts, **average turnaround against the promised hours**, and the share reported within the promise.
- Money, shown in two honest parts: **collected at the lab desk** (exact, from the invoices), and the tests ordered on visits at **list price** (these are billed with the visit after any panel rate or discount, so it is the value of the work, not what was collected).

## Who can do what

| | |
|---|---|
| See the worklist, open an order, read signed reports | lab, doctor, nurse, administrator (front office: signed reports) |
| Collect a sample / start a study | lab, nurse, doctor, administrator |
| Reject a sample | lab, administrator |
| Enter results, write a report, sign, amend, attach images | lab, doctor, administrator |
| Cancel a test | lab, doctor, administrator |
| Acknowledge a critical value | doctor, administrator |
| Raise a lab-desk invoice, see invoices | lab, front office, biller, administrator |
| Cancel a lab-desk invoice | biller, administrator |
| Figures | lab, administrator |

The **lab** role is new: it can look patients up (read only) and see the list of billing categories, but cannot register or change patients.

## Not built (by design, for now)

Instrument / analyser integration, outside-lab referrals and sample transport, barcode labels, reference ranges that differ by age or sex (put the range in the text, or set up two tests), DICOM images (PDF, PNG, JPEG and WEBP only), and the patient app to see reports (Phase 4). Images need file storage to be set up: until the India storage is connected, saving an image in production is refused with a clear message (see DOCUMENTS.md).

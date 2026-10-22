<!-- From AIVA OSHealth, adapted to the merged application. -->
# Masters and inpatient billing

## Masters (`/api/v1/masters`, screen: Masters)

Everything that has a price is read from these lists; there is no built-in price list any more. Administrators change them; anyone signed in can read the services and tests (the screens that charge or order them need the list).

| Master | What it holds |
|---|---|
| **Hospital settings** | GSTIN, registration number, standard OPD fee (for a doctor with none of their own), emergency fee, price of a test or medicine that is not on the lists, GST on an unlisted medicine, the hour a bed day ends, consent wording, bill footer. Only values you change are stored; the rest use the defaults in `backend/src/hospital/modules/masters/settings.ts`. |
| **Wards and bed charges** | One daily rate (and GST) per ward. A ward with no rate cannot be billed: its stays show a warning. |
| **Services** | Nursing, procedures, doctor visits, packages: code, name, kind, price, GST, active. |
| **Tests** | Lab and radiology tests: code, name, section, sample, turnaround hours, price, GST, active. A lab test lists its **parameters with normal ranges** (low, high, or text such as "Nil"). Ranges you enter are used by result entry and reports (Phase 3). |
| **Panel rates** | A panel's own rate for any service or test. Where it has none, the panel's discount % comes off the standard price; otherwise the standard price. |
| **Prescription templates** | A doctor's saved sets of medicines (private), or ones an administrator shares with every doctor. A template only fills in the lines; each still goes through the allergy and duplicate checks. |

`npm run seed:masters [HFR ID]` (in `backend/`) adds **example** price lists (ward rates from the ward names, ~13 services, 13 tests with typical adult ranges, 3 templates) to a hospital that has none. The prices and ranges are examples: replace them with the hospital's own.

Orders: a test typed or picked in an order is matched to the test list by name (and takes the list's spelling); an unmatched name is charged at the "unlisted test" price. Medicines are charged at the stock list's MRP and GST when dispensed.

## An admission, billed

1. **Admission.** The billing category (self-pay or a panel, with the card number when the panel needs one) can be set at admission or later by the front desk or billing. A reserved bed can be taken only by the patient it is reserved for (or by anyone once the reservation has lapsed).
2. **Bed days.** Posted automatically, once per bed day, at the rate of the ward the patient was in when the day ended: the admission day counts, and each later date counts if the patient was still in at that day's checkout hour (12:00 by default, Indian time). Moving ward is tracked bed by bed. A day is posted once; a voided day is never re-posted.
3. **Charges.** The ward (nurse, doctor) can add services from the list; the rate follows the billing category. The billing counter and administrators can change a rate (with a reason), add an item that is not on the list, and void a charge (with a reason). Nothing is deleted. Charges can be dated back to the admission, never into the future. After discharge only the billing counter can add or void, and only until the final bill is finalized.
4. **Tests and medicines** come from the visit's orders and dispensed prescriptions, priced from the lists (and the panel).
5. **Advances.** The front desk and billing counter take advances (cash, UPI, card, other; UPI and card need the transaction id) with numbered receipts (`ADV-n`). The billing counter can refund part of an advance (`RF-n`, reason needed, never more than is held) and cancel an advance entered by mistake (the receipt stays, marked cancelled).
6. **Running bill.** `GET /ipd-billing/:encounterId`: every line, subtotal, GST, total, advances held and the balance, always current. It can be printed as an interim bill.
7. **Final bill.** Made after discharge from the running bill (`POST /ipd-billing/:encounterId/final-bill`; discharge also creates the draft). While it is a draft the counter can refresh it, give a **discount** (percent or amount, reason required, shared across GST rates in proportion so the tax stays right; shown as its own lines), and add late charges. **Finalize** freezes it. **Settle:** the advances come off; what is left is collected as one settlement receipt (`IPD-n`), or, if the advances were more than the bill, the difference is given back as a refund receipt. A UPI or card settlement needs a reference; cash may record what was handed over.
8. **Printouts:** interim bill, final bill / tax invoice (with GSTIN, amount in words), advance / refund / settlement receipts, admission form with consent, discharge summary, birth certificate (hospital copy).

## Reserved beds

`POST /beds/:id/reserve` (front desk, nurse, admin) keeps a vacant bed for a registered patient or a named person, optionally until a time. It is not offered to other admissions. `POST /beds/:id/clear-reservation` gives it up. Admitting the patient it is reserved for uses it.

## Births

`POST /ipd/:encounterId/births` (nurse, doctor, admin) records a newborn against the mother's admission: sex, date and time, weight, type of delivery, father's name, attended by. Each gets a birth register number (`BR-n`). The printed certificate is a hospital record; it does not replace registration with the local registrar.

## Documents

See DOCUMENTS.md.

## Text messages and one-time codes

`SMS_PROVIDER=simulator` (the only provider for now) writes messages to the `SmsOutbox` table instead of sending them (administrators can read them at `GET /messages/outbox`), and the OTP is always `123456`. `OtpService` issues and verifies codes (5-minute expiry, 5 tries, 5 requests per number per hour, only a hash stored). The patient app will use it; a real provider is one more class in `backend/src/hospital/modules/messaging`.

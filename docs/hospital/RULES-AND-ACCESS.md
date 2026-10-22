<!-- From AIVA OSHealth, adapted to the merged application. -->
# Business rules and who can do what

## Who can reach what

Everything needs a signed-in staff member. Roles: `front_office`, `doctor`, `nurse`, `pharmacist`, `biller`,
`housekeeping`, `admin`. The rules sit next to the routes (`backend/src/hospital/index.ts` for whole areas, the module for single actions).

| Area | Can view | Can change |
|---|---|---|
| Patients | front office, doctor, nurse, pharmacist, biller, lab (look-up only), admin | front office, doctor, nurse, biller, admin (the billing counter registers a new patient when billing finds none) |
| Visits (OPD / ER / IPD) | front office, doctor, nurse, admin | same |
| Beds, housekeeping log | front office, doctor, nurse, housekeeping, admin | add a bed: admin. Cleaning steps: housekeeping, nurse, admin |
| Pharmacy | stock levels: pharmacist, doctor, nurse, admin. Everything else (queue, sales, purchases, suppliers, reports): pharmacist, admin | items, purchases, sales, stock adjustments, dispensing: pharmacist, admin (see PHARMACY.md) |
| Lab and radiology | worklist, orders, signed reports: lab, doctor, nurse, admin (front office: signed reports); invoices: lab, front office, biller, admin; figures: lab, admin | collect a sample: lab, nurse, doctor, admin; results, reports, signing, amending: lab, doctor, admin; acknowledge a critical value: doctor, admin; cancel a lab-desk invoice: biller, admin (see LAB.md) |
| Ward medicine round | nurse, doctor, admin | schedule and give doses: nurse, doctor, admin |
| Drug-name search and check | doctor, nurse, pharmacist, admin | read-only |
| Billing | biller, admin | biller, admin |
| OPD billing (invoices, consultation fees) | front office, biller, admin | front office, biller, admin. **Discounts, cancelling an invoice and refunds: biller and admin only** |
| Panels and their rates (CGHS, DGHS ...) | front office, biller, admin, and doctor / nurse (to pick the billing category at admission) | admin |
| Masters (settings, wards, services, tests, panel item rates) | settings, services, wards, tests: everyone signed in; panel item rates: biller, admin | admin |
| Prescription templates | doctor, admin | a doctor: their own; admin: all, and can share one with every doctor |
| IPD billing (running bill, charges, advances, final bill) | front office, doctor, nurse, biller, admin | add a service from the list: nurse, doctor, front office, biller, admin. Advances and billing category: front office, biller, admin. **Changed rates, one-off items, voiding, refunds, discounts, final bill and settlement: biller and admin only** |
| Reserved beds | everyone who sees beds | reserve / release: front office, nurse, admin |
| Births | nurse, doctor, front office, admin | nurse, doctor, admin |
| Attached documents | nurse, doctor, front office, biller, admin | attach: same. Remove: doctor, admin |
| Text-message outbox (simulator) | admin | - |
| Platform console (hospitals) | platform administrators only (separate sign-in) | platform administrators |
| Supplies | front office, nurse, admin | issue: front office, nurse, admin. Add / restock: front office, admin |
| Bio-medical waste | front office, nurse, housekeeping, admin | housekeeping, nurse, admin |
| Roster | everyone | front office, admin |
| Attendance, payroll | admin | admin |
| Staff list | everyone (salary, bank and login details hidden unless admin) | admin |
| Staff logins, audit log, facility edits | admin | admin |
| Patient registration and ABHA (the M1 screens: `/api/patient`, `/api/abha`, Scan & Share) | front office, doctor, nurse, biller, admin | same (pharmacist, housekeeping and lab are refused) |
| Dashboard counts | everyone | - |

## Rules the server enforces

**Hospitals are kept apart.** Every request works on one hospital's own data and nothing else (see ../HOSPITAL_MODULES.md, "Several hospitals"). **Prices come from the hospital's Masters** and **inpatient billing** (bed days, charges, advances, final bill, discounts, settlement) follows the rules in MASTERS-AND-IPD.md.

**OPD invoices, panels, discounts and refunds.** OPD billing has its own screen. Find the patient (or register them), choose the doctors, the billing category
(self-pay, or a panel such as CGHS or DGHS) and any discount, take the payment: one **OPD invoice** (also the receipt, numbered OPD-n) is generated, with an appointment slip and
token for each doctor.
- *Panels.* An administrator sets up each panel (`/panels`) and enters the rates the hospital has agreed; none are built in. A panel's fee for a consultation is its rate for that
  department, else its flat fee, else the doctor's standard fee less the panel's discount %. A panel can require the beneficiary / card number at billing. A panel with nothing
  set charges the standard fee (and the screen says so). The panel and card number are kept on the invoice as they were at billing time.
- *Discounts.* Percentage or amount, for the billing counter and administrators only (the front desk bills at standard or panel rates). A reason is required, a discount cannot
  exceed the amount, and it is shared across the doctors so the lines add up exactly. It shows as its own line under each doctor on the invoice and in the audit log.
- *Quote.* `POST /opd-billing/quote` prices the doctors (or registered fees) with a panel and discount without saving anything; the screen uses it to show the total as you choose.
- *Invoices.* `GET /opd-billing/invoices?from&to&status&search` lists a day or range of days (today by default; Indian calendar days) with totals, and `GET /opd-billing/invoices/:id`
  gets one, so any invoice can be viewed and reprinted later, with its lines, panel, discount, payment mode and reference, who billed it, and its slips.
- *Cancelling with a refund.* `POST /opd-billing/invoices/:id/cancel` (billing counter and administrators): needs a reason; refunds everything paid by default, or less (to keep a
  cancellation charge), in the mode it was paid or another (UPI and card refunds need a reference). Only while every consultation on the invoice is still waiting: once a doctor has started,
  it is refused and nothing changes. Cancelling voids the fee bills and cancels the visits. The day's totals show collected, refunded and net, and net by payment mode.

**The OPD flow: registration, then OPD billing, then the queue. A patient may see several doctors.**
A patient can be registered for more than one doctor in the same visit, one per speciality (department), by the front desk or at OPD billing.
Each doctor is a separate consultation with its own fee bill, token, queue place and appointment slip. Each doctor has their own patient fee
(`consultationFee` on the staff record, set by an administrator; otherwise the standard OPD fee, ₹600). A bill keeps the fee it was raised at, even if the
doctor's fee changes later. The same speciality cannot be opened twice for one patient while a visit there is open.
1. *Registration.* Registering an OPD visit (`POST /encounters/opd`) creates it as `awaiting_payment`: no token, not in the queue, and nothing
   clinical can be recorded on it. A consultation-fee bill (`kind = opd_fee`, ₹600 from the tariff) is raised with it. A patient cannot have two
   open visits in the same department (awaiting payment, waiting, or in consultation); two different departments are fine.
2. *OPD billing.* `POST /opd-billing/visits` registers a patient for one or more doctors at once (all or none). `GET /opd-billing` lists consultations
   waiting to pay. `POST /opd-billing/collect` takes **one payment** for one or more of one patient's fees: it records a receipt (`RCPT-n`, payment mode,
   reference, cash received and change, who collected it and when), marks every fee paid by that receipt, issues each doctor's next token
   (numbered per department by the Indian calendar day they are issued, so the order of payment is the order of the queue) and moves each visit to `waiting`.
   All or nothing: if any fee cannot be paid, none is. UPI and card payments need a transaction id or card slip number; cash may record the amount handed over
   (it must cover the amount due). One payment cannot mix two patients. The response includes one appointment slip per doctor.
   `GET /opd-billing/payments?date=` lists a day's payments (today by default) with totals by payment mode and the slips, for reprinting.
   `POST /opd-billing/:billId/collect` is the same for a single fee. `POST /opd-billing/:billId/cancel` is for a patient who leaves without
   paying: the bill is voided, the visit is `cancelled`, and no token is issued. A paid or cancelled visit cannot be collected or cancelled again.
   Front office, billers and administrators may do this; clinical staff may not. A fee bill cannot be finalised or paid through `/bills`.
3. *The queue.* Only `waiting` and `in_consult` visits are in the OPD queue.
4. *After the consultation.* Closing the visit does not charge the consultation fee again. Tests ordered and medicines already dispensed go on a
   second bill (`kind = final`); if there is nothing more to charge, the visit just completes (`bill` is null) and is marked billed.
   Visits created before this flow existed (no fee bill) are still billed the consultation fee when closed.

**Supplies.** Stock never goes below zero: issuing more than is in the store is refused. Every issue and restock is
logged with who and when.

**Bio-medical waste** (CPCB BMW Rules 2016: yellow, red, white, blue). A batch only moves forward:
`segregated -> stored -> (pretreated) -> disposed`. Pre-treatment needs a stored batch. Disposal needs a stored or
pre-treated batch and records the vendor and manifest number. Whether a colour *should* be pre-treated is guidance
shown on screen, not enforced.

**Housekeeping.** A bed becomes `dirty` when a patient is discharged, then `cleaning`, then `vacant`; steps cannot be
skipped. Discharge release and each cleaning step are logged.

**Roster vs attendance.** The roster is the plan; attendance is what happened. A person can hold several shifts on one
date (a double shift). Deactivated staff cannot be rostered. "Copy week" skips assignments that already exist.

**Payroll** (one run per month: `draft -> finalized -> paid`):
- Salaried staff: attendance is per shift. A present shift counts 1, a half-day 0.5, absent or leave 0. A date with
  two or more present shifts is a double shift and earns more than one day. Pay = monthly salary x days / 26. If no
  attendance was recorded for the month at all, a full month (26 days) is assumed.
- Visiting doctors: fee per consultation x finished OPD visits in the month (hospital calendar month, IST).
- Only active staff are included. Deductions can change on a draft only and cannot exceed gross pay.
- Once finalized the figures are frozen: attendance for that month cannot change, and later salary changes do not
  alter the saved payslips. A draft can be deleted and generated again.

**AI assistant** (consultation screen): doctors and administrators only; dictation and suggestions are drafts that never change
the record. Only clinical facts reach the model (never name, MRN, phone or ABHA number). Allergy, duplicate and pharmacy-stock checks
are done by the server, not the model. Prescription lines the doctor adds from a suggestion are flagged `aiSuggested` and audited.

**Passwords and sessions.** One login for the whole application (`POST /api/user/admin/login`, e-mail and password; bcrypt hashes).
5 wrong passwords lock a login for 15 minutes; a new or reset login must choose its own password before anything else; a password change,
deactivation or removed login ends its sessions immediately (the session carries a version that is checked on every request).

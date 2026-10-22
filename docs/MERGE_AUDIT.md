# Merge audit: hmsmerge + AIVA OSHealth

Result of merging the OSHealth prototype (`aiva-oshealth-main`, the staff app, and `aiva-oshealth-api-main`, its API) into hmsmerge, the
ABDM M1 certified application. hmsmerge was the starting point; nothing of its M1 behaviour was replaced. The plan is in
[MERGE_PLAN.md](MERGE_PLAN.md); how the merged code works is in [HOSPITAL_MODULES.md](HOSPITAL_MODULES.md). A copy of hmsmerge as it was
before the merge is in `Documents\hmsmerge_pre_merge_backup`.

## 1. What is in the merged product

| Area | Source | Where it lives now |
|---|---|---|
| ABHA create / link / verify, Scan & Share, facility and ABDM credentials, registration | hmsmerge (certified M1) | unchanged routes (`/api/facility`, `/api/user/admin`, `/api/patient`, `/api/abha`, `/api/v3/hip`) |
| OPD billing (invoices, receipts, panels, discounts, refunds), OPD queue, consultations (SOAP, vitals, prescriptions, orders, templates), AI assistant, drug search (241,925 Indian brands + RxNorm) | OSHealth | `/api/v1` (`backend/src/hospital`), `frontend/src/hospital` |
| Emergency (triage), IPD (bed board, transfers, reservations, births, documents), housekeeping, bio-medical waste, ward medicine round | OSHealth | same |
| Pharmacy (stock, batches, counter sales, purchases, suppliers, GST), lab and radiology (worklist, signed reports, critical values, attachments, lab-desk invoices), final bills, IPD billing | OSHealth | same |
| Masters (price lists), supplies, roster, attendance, payroll, staff access, audit log, facility profile | OSHealth | same |
| Platform console (hospitals set up and switched off), several hospitals on one installation | OSHealth (redesigned for one schema) | `/api/v1/platform`, `/platform` |
| Demo hospital, example price lists, AI key check | OSHealth | `npm run seed:demo`, `seed:masters`, `ai:check` |

Not carried over, on purpose: OSHealth's simulated ABDM module and screens (replaced by the certified M1 integration), its stand-alone
browser-only demo mode and role switcher (one real sign-in instead), its PGlite embedded database and per-hospital PostgreSQL schemas
(one Prisma-managed schema with `facilityId` on every row), and its username-plus-hospital-code login (e-mail login).

## 2. Conflicts found, and how each was resolved

| Conflict | Resolution |
|---|---|
| Two data models for patients, staff, facility, audit | One schema. Patient/Staff/Facility/User extended additively; `AbhaPatient` stays the source of ABHA state; the hospital screens read ABHA status and number from it. `AuditLog` (everything) and `AbhaAuditLog` (ABHA metadata) both kept. |
| Two sign-ins (cookie JWT vs bearer token; username vs e-mail) | One login (`/api/user/admin/login`, e-mail). The cookie is honoured by both halves; bearer tokens still work for scripts. Roles, lockout, forced password change and session versioning apply to every route. |
| Hospital identity | The HFR ID is the hospital's code and its ABDM HIP id (Scan & Share is routed by it), and is read-only. |
| Per-hospital schemas vs `facilityId` columns | `facilityId` everywhere. Hospital SQL uses a `:fid` placeholder filled from the signed-in request's scope; a statement outside a scope throws. A test checks that every statement on a hospital table carries `:fid`. |
| Numbering (MRN, bills, receipts ...) | Per-hospital counters in the database (`next_facility_number`, trigger-assigned MRN/BILL/OPD/BR/PUR), existing patients back-filled in registration order. |
| Timestamps (naive vs timestamptz) | Earlier hospital tables converted to `timestamptz` (read as UTC); the node-postgres type parsers give the screens the values OSHealth expected. |
| CSRF guard (JSON only) vs file uploads | Two exact upload routes may carry a file (PDF/PNG/JPEG/WEBP/octet-stream); every other state change must be JSON from an allowed origin. |
| Two rate-limit implementations | The merged API uses one switch; limits can be turned off only outside production (the hospital modules were aligned to this). |
| Two error formats | Each half keeps its own (`success/message` for M1, `{ error: { code, message } }` for `/api/v1`); the frontend client understands both. |
| Two stylesheets (generic class names `.card`, `.btn`, `.table`, `.badge`, `.steps` in both) | OSHealth's rules are re-drawn with hmsmerge's design tokens and scoped under `.os-page`; they cannot change the M1 screens. |
| Two page layouts (OSHealth `.topbar` page heading vs hmsmerge `.topbar` application bar) | OSHealth headings renamed `.os-head`. |
| Two navigations | One role-based menu (`navConfig.ts`) containing the M1 patient screens and the hospital screens; a role is also kept off screens it cannot use. |
| Patient registration in two places | M1 registration is the one place a patient (and ABHA) is created; the hospital's registration dialog hands over to it for ABHA. Gender, now needed by the hospital screens, is recorded at M1 registration. |

## 3. Defects found and fixed while merging

- **Pharmacy bill gap (from OSHealth):** a medicine dispensed after the visit was closed never reached the bill. It is now added to the
  draft bill (or a draft is created), and a finalised bill is reported to the pharmacist and the audit log. Test added.
- **Pharmacy queue** reported medicines not on the stock list as "listed, stock 0"; it now says they are unlisted.
- **Deactivated staff** kept their sessions and could still request a password reset; deactivation now ends sessions and clears the request.
- **Forgot-password** accepted an empty request (OSHealth refused it); restored.
- **Hospital rate limits** could be switched off in production through `RATE_LIMIT_ENABLED`; now only outside production, as in the M1 limiter.
- **Concurrent queries on one transaction connection** (a driver warning that becomes an error in pg 9); statements in a transaction are now serialised.
- **Test hygiene:** the AI tests could have used a developer's real AI key; they are now hermetic. One ported ward-round test depended on the time of day
  (a real 14:00 dose inside the two-hour window broke its ordering check); it now checks only its own doses.
- **M1 gap:** registration through the M1 API could not record gender; added (`M`, `F`, `O`, validated).

## 4. Verification

Run against local PostgreSQL 18 only (the hosted database in `backend/.env` was never used for migrations or tests).

| Check | Result |
|---|---|
| Prisma migration chain applied from scratch; drift check against the schema | applied; "No difference detected" |
| Migration on baseline-shaped data (MRN back-fill order, timestamp conversion, login without staff record) | verified |
| Backend type-check and production build (`tsc`), compiled build starts and loads the drug list | clean |
| Hospital test suite (`npm run test:hospital`): 18 files ported from OSHealth plus auth, multi-tenant and demo-seed tests | **275 / 275 pass** (68 suites) |
| Original hmsmerge M1 tests (against the running merged backend) | 8 / 8 pass |
| SQL scope test (every hospital statement carries `:fid` or is marked cross-hospital) | pass |
| Cross-hospital isolation (M1 routes and hospital modules, 40 interleaved requests), suspension, platform access | pass |
| Frontend type-check and production build | clean; main bundle 442 kB, 25 hospital screens load on demand |
| Browser walk-through (administrator, doctor, pharmacist, lab, billing, new hospital administrator, platform console) | below |
| `npm audit` | frontend 0; backend 0 (the 3 high findings in the Prisma CLI's `deepmerge-ts` were cleared by upgrading Prisma 6.19.3 → 7.10.1, section 6) |

Browser walk-through, as real users on the demo hospital, with no console errors:

1. Administrator signs in: dashboard shows the hospital's counts and the ABHA overview; every menu screen (OPD billing, emergency, IPD,
   medicine round, lab, IPD billing, bills, panels, pharmacy, supplies, housekeeping, waste, roster, payroll, masters, facility, staff access,
   audit) renders with data.
2. A patient registered on the M1 screen is opened, sent to OPD billing from their record, billed (invoice OPD-1004 / BILL-1004 printed under the
   hospital heading), then taken through a consultation by the doctor (template prescription, SOAP note, vitals, CBC order) and closed.
3. Pharmacist: sees only the pharmacy (M1 screens refused); dispenses the prescription (DISP-1).
4. Lab: collects the sample (LS-1), enters results (high WBC flagged), signs the report.
5. Billing: the lab test appears on the visit's bill; the doctor's menu hides billing, payroll and setup, and a direct visit to `/payroll` is refused.
6. Platform console: signs in, sets up a new hospital; its administrator is forced to choose a password, then sees an empty hospital.

## 5. Known limits and recommended next steps

- **ABDM live testing** of Scan & Share and the M1 flows against the real sandbox needs a public URL and sandbox credentials; the merge does
  not change those code paths, but they were not re-run against ABDM here.
- **Next ABDM milestones (M2/M3)** are not built (as in both originals); the hospital data model (encounters, prescriptions, lab results) is
  the base for them.
- **Document storage:** uploads are off in production until a persistent store is chosen (`FILE_STORE`); an S3-compatible store is the
  documented next step.
- **SMS:** the OTP/SMS provider is a simulator (as in OSHealth); connect a real gateway before patient-facing use.
- **Frontend tests:** the screens are verified by build and walk-through; automated browser tests would be a sensible addition.
- **Cleanup of local test data:** the local test databases and the demo hospital are on the developer's machine only; no demo data was added to the hosted database.

## 6. Prisma 7 upgrade (after the merge)

The backend's three high `npm audit` findings were all one advisory, in `deepmerge-ts` used by the Prisma CLI; Prisma 6.19.3 is the last 6.x
release and still carried it, so the fix was Prisma 7.10.1. Changes: `prisma`, `@prisma/client` and the new `@prisma/adapter-pg` at 7.10.1; the
connection URL lives in `prisma.config.ts` only (removed from `schema.prisma`, `engine: "classic"` removed); `src/config/db.ts` builds the client on the
PostgreSQL adapter (30 s connection wait kept for a sleeping hosted database; Prisma-only URL parameters such as `connect_timeout` are stripped for the
driver; pool size `PRISMA_POOL_MAX`, default 10). No schema or migration changed: drift check "No difference detected".
Re-verified after the upgrade: backend type-check and compiled build (starts, answers `/health`, queries the database), M1 tests 8 / 8, hospital tests
275 / 275, `npm audit` 0 vulnerabilities. The Dockerfile and `render.yaml` needed no change.

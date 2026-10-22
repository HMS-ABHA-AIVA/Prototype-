# Merge plan: hmsmerge + AIVA OSHealth (frontend and API)

Status: approved approach, being executed. Baseline: hmsmerge as delivered (ABDM M1 certified), backed up untouched at
`C:\Users\ayush\Documents\hmsmerge_pre_merge_backup` before any change.

## 1. What each codebase brings

| | hmsmerge (base) | OSHealth API (`aiva-oshealth-api-main`) | OSHealth web (`aiva-oshealth-main`) |
|---|---|---|---|
| Stack | Express 5, Prisma, PostgreSQL, cookie JWT | Express 5, plain SQL (`pg` / PGlite), bearer JWT | React 19, Vite, zustand |
| Size | ~5.6k lines backend, ~6.6k frontend | ~12k lines, 14 SQL migrations, 27 HTTP test files | ~16k lines, 60 screens/components |
| Strength | ABDM M1 (ABHA create/verify/link, Scan & Share), NDHM security controls, certified | Whole hospital: OPD/ER/IPD, billing, pharmacy, lab, masters, payroll, roster, supplies, waste, AI assistant, drug search | Every screen for the above, role-based navigation, prints |
| Tenancy | `facilityId` column on every row | one PostgreSQL schema per hospital | n/a |
| Identity | Facility owner login + staff `User` (email) | `staff` row with username login, platform admins | sessionStorage token |

hmsmerge had already started this merge: migrations `stage0_foundation` (roles, Staff, HospitalSetting, AuditLog,
FacilityCounter, MRN columns, facility profile) and `stage1_beds` (Bed, HousekeepingLog) exist, with no code using them yet.
This plan continues that approach.

## 2. Target architecture (one application)

```
React app (hmsmerge shell + OSHealth screens, one design system)
   │  cookie session (httpOnly), same origin through the Vite proxy / FRONTEND_URL in production
   ▼
Express app (hmsmerge src/app.ts)
   ├─ /api/facility, /api/user/admin, /api/patient, /api/abha, /api/v3/hip, /api/dashboard   ← hmsmerge, unchanged (M1)
   └─ /api/v1/*   ← OSHealth hospital modules, ported (same paths and JSON so its screens work as they are)
   ▼
PostgreSQL, ONE schema owned by Prisma migrations, facilityId on every row
```

* **Schema**: every OSHealth table becomes a Prisma model (PascalCase table, camelCase columns, like the existing hmsmerge
  and stage 0/1 tables). `prisma migrate deploy` remains the only migration path. New migrations are additive; no existing
  migration file is edited.
* **Data access in the ported modules**: OSHealth's business rules are kept as they are, including their SQL (transactions,
  `SELECT … FOR UPDATE` locks, reports), run through `node-postgres` on the same database. Every statement on a hospital table
  filters by `"facilityId"`; a test checks that statically, and isolation tests prove one hospital cannot read another's data.
  Simple hmsmerge-style code keeps using Prisma.
* **Tenancy**: hmsmerge's model wins (facilityId). OSHealth's schema-per-hospital and hospital codes are not needed.

## 3. Conflict map and resolution

| Area | hmsmerge | OSHealth | Resolution |
|---|---|---|---|
| ABDM M1 (ABHA, Scan & Share, `/api/v3/hip`) | certified implementation | own implementation + simulator | **hmsmerge wins, untouched.** OSHealth's ABHA client, callbacks and simulator are not merged (a second ABDM stack would conflict on `/api/v3/hip` and on certification). Its admin read-outs (status, readiness checklist, connection check) are rebuilt on hmsmerge's credentials. |
| Patients | `Patient` + `AbhaPatient` (ABHA link, name/DOB match) | `patients` with `abha_number` | **One `Patient` table.** Adds `yearOfBirth` (age-only registration). MRN issued by a database trigger, so every path (M1 registration, Scan & Share, OPD) gets one without touching certified code. `/api/v1/patients` serves OSHealth's shape from the same rows; ABHA linking only through hmsmerge's M1 flows. |
| Staff sign-in | `User` (email, bcrypt, cookies) | `staff.username` (scrypt, bearer) | **hmsmerge login wins** (email). Adds OSHealth's safeguards: roles enforced, lockout after 5 wrong passwords (15 min), session ended on password change / deactivation (token version), must-change-password, forgot-password request, `/api/v1/auth/me`. |
| Staff records | `Staff` (stage 0) | `staff` | Stage 0 `Staff` is the person; `User` is their login (`Staff.userId`). |
| Facility | owner login, ABDM credentials, HFR id | single profile row | Profile fields already on `Facility` (stage 0). HFR id stays read-only (it is the HIP id Scan & Share routes on). |
| Multi-hospital / platform | open facility registration | platform console, suspend hospital | Kept both: `Facility.status` (active / suspended) blocks every login of a suspended hospital; platform administrators get their own console. |
| Audit | `AbhaAuditLog` (ABHA metadata) | `audit_log` | Both: `AbhaAuditLog` stays for ABHA, `AuditLog` (stage 0) for everything else. |
| Dashboard | ABHA counts | operations counts | Both endpoints; one dashboard screen shows both. |
| Error format | `{ success, message, code }` | `{ error: { code, message } }` | `/api/v1` keeps OSHealth's format (its screens read it); hmsmerge routes unchanged. |
| Frontend shell, sign-in, registration | certified M1 screens, `hms.css` | own shell, demo store, ABHA step | **hmsmerge shell and M1 screens win.** OSHealth screens replace the "Demo" menu items, re-styled on `hms.css`; its in-browser demo store is dropped (always the real API). |
| CSS | `hms.css` | `global.css` (37 class names clash) | One design system: `hms.css`, plus the OSHealth-only classes re-tokenised in `modules.css`. |

## 4. Stages

| Stage | Content |
|---|---|
| 2 Platform | Migration for auth columns, facility status, `yearOfBirth`, MRN trigger, timestamptz/defaults on stage 0/1 tables. `/api/v1` scaffolding (errors, role guard, SQL helper), auth, staff + logins, facility profile, audit, settings, dashboard. |
| 3 Clinical | Encounters (OPD/ER/IPD), vitals, prescriptions, orders, beds & housekeeping, bills, discharge draft, AI assistant, drug search (Indian brand list + RxNorm). |
| 4 Billing & masters | OPD billing and invoices, panels, masters (services, wards, investigations, panel item rates, Rx templates). |
| 5 IPD | Running bill, charges, advances/refunds, final bill, reserved beds, births, documents (file store). |
| 6 Pharmacy | Batches, suppliers, purchases, sales, stock ledger, GST reports, ward medicine round. |
| 7 Lab | Worklist, samples, results, signed reports, amendments, critical values, lab-desk invoices, MIS. |
| 8 Operations | Supplies, bio-medical waste, roster, attendance & payroll, SMS simulator / OTP, platform console. |
| 9 Frontend | Merge screens, navigation by role, sign-in session (role, must-change-password), styles. |
| 10 Verify | Port OSHealth's HTTP tests to the merged API, keep hmsmerge's tests, type-check, build, browser walk-through, audit report. |

## 5. Verification

* Local PostgreSQL 17 only (never the hosted database in `backend/.env`).
* hmsmerge's existing tests must still pass unchanged (M1 regression guard).
* OSHealth's 27 test files ported to the merged API (each runs in its own throwaway hospital).
* Facility isolation tests and a static check that hospital SQL is facility-scoped.
* `tsc` (backend, frontend), `vite build`, browser walk-through of every screen per role.
* Final audit: `docs/MERGE_AUDIT.md`.

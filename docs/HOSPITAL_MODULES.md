# Hospital modules (merged from AIVA OSHealth)

The backend is one application with two halves that share one database, one sign-in and one set of security rules:

| | What | Routes | Code |
|---|---|---|---|
| **M1 (ABDM)** | Patient registration, ABHA creation and linking, Scan & Share, facility and ABDM credentials. Certified M1 flows, unchanged by the merge. | `/api/facility`, `/api/user/admin`, `/api/patient`, `/api/dashboard`, `/api/abha`, `/api/v3/hip` | `backend/src/modules`, `backend/src/integration` |
| **Hospital modules** | OPD, emergency, IPD, beds and housekeeping, pharmacy, lab and radiology, billing (OPD, IPD, panels), masters, staff, roster, payroll, supplies, bio-medical waste, AI assistant, drug lookup, platform console. | `/api/v1/...` | `backend/src/hospital` |

The OSHealth screens' behaviour is kept route for route (`/api/v1/...` as before); the detailed rules are in [docs/hospital](hospital/):
[who can do what](hospital/RULES-AND-ACCESS.md), [masters and IPD billing](hospital/MASTERS-AND-IPD.md), [pharmacy](hospital/PHARMACY.md),
[lab and radiology](hospital/LAB.md), [attached documents](hospital/DOCUMENTS.md), [drug data](hospital/DRUG-DATA.md), [AI providers](hospital/AI-PROVIDERS.md).

---

## Architecture

- **One database, one schema.** Every table is in `backend/prisma/schema.prisma` and every change is a Prisma migration
  (`npx prisma migrate deploy`). The hospital tables follow the M1 naming (PascalCase tables, camelCase columns) and every row carries
  `facilityId`, the hospital it belongs to.
- **Two ways in, same rows.** The M1 code uses Prisma. The hospital modules use plain SQL through `backend/src/hospital/db.ts`
  (node-postgres): reporting, locking and numbering queries are written as SQL, as they were in OSHealth. A patient registered on an
  M1 screen is the same `Patient` row the OPD, billing and lab screens see, and the reverse.
- **Hospital scope, fail-closed.** Each signed-in request runs inside its hospital's scope (`AsyncLocalStorage`). Hospital SQL refers
  to the hospital as `:fid`, which `db.ts` fills from that scope; a statement that uses `:fid` outside a scope throws instead of
  running. Work that really spans hospitals (sign-in, the platform console) goes through `db.platform`, which refuses `:fid`.
  `tests/hospital/sql-scope.test.ts` checks that every SQL statement on a hospital table carries `:fid` (or is marked as crossing hospitals).
- **Transactions** hold one connection and run their statements one at a time, in the order issued.
- **Errors** from `/api/v1` keep OSHealth's shape: `{ "error": { "code", "message", "details"? } }`. The M1 routes keep theirs.

## Sign-in and sessions

- **One login** for the whole application: `POST /api/user/admin/login` with `{ email, password }`. It sets the `accessToken` cookie
  (httpOnly) and returns the person's `role`, `staffId`, `department` and `mustChangePassword`. The hospital routes also accept the token as
  `Authorization: Bearer` (scripts, tests). Sign-out: `POST /api/user/admin/logout`.
- `GET /api/v1/auth/me` (who am I, which hospital), `POST /api/v1/auth/change-password`, `POST /api/v1/auth/forgot-password` (flags the
  login for an administrator; answers the same whether or not the address has a login).
- **Roles:** `front_office`, `doctor`, `nurse`, `pharmacist`, `biller`, `lab`, `housekeeping`, `admin`. Logins that existed before the merge are
  administrators. The M1 registration and ABHA screens are refused to pharmacists, housekeeping and lab staff.
- **Safeguards** (on every route, M1 and hospital alike): 5 wrong passwords lock a login for 15 minutes; a new or reset login must choose its own
  password before anything else (`403 PASSWORD_CHANGE_REQUIRED`); a password change, deactivation or removed login ends every session at once
  (the token carries a version checked on each request); a suspended hospital is refused (`403 HOSPITAL_SUSPENDED`).
- **Staff logins** are managed on the Staff Access screen (`PUT /api/v1/staff/:id/login` with `{ email, password }`), and
  facility owners can still create administrators with `POST /api/facility/create-admin`. E-mail addresses are unique across the installation.
- **CSRF:** every state-changing request must be JSON (send `{}` when there is nothing to send), from an allowed origin. The two upload routes
  (`POST /api/v1/ipd/:id/documents`, `POST /api/v1/lab/orders/:id/attachments`) take the file itself (PDF, PNG, JPEG, WEBP; 10 MB).

## Several hospitals

One installation can serve several hospitals. Their data never mixes: every query is limited to the signed-in person's hospital
(`tests/hospital/multi-tenant.test.ts` checks this for the M1 routes and the hospital modules).

- A hospital's **code is its HFR ID**, which is also its ABDM HIP id: Scan & Share callbacks are routed by it. It is fixed once set
  (`400 HFR_ID_FIXED` if a screen tries to change it).
- **Numbering starts afresh in each hospital:**

  | Record | Format | Record | Format |
  |---|---|---|---|
  | Patient (MRN) | `MRN-10001` | Bill | `BILL-1001` |
  | OPD invoice / receipt | `OPD-1001` | Birth | `BR-1` |
  | Pharmacy purchase | `PUR-1` | Pharmacy invoice | `PH-1` |
  | Dispense | `DISP-1` | IPD advance / refund / receipt | `ADV-1`, `RF-1`, `IPD-1` |
  | Lab invoice | `LB-1` | Lab sample, radiology accession | `LS-1`, `RD-1` |

- **Platform console** (`/api/v1/platform`) for the people who run the product, with its own sign-in (`PLATFORM_ADMIN_USERNAME` /
  `PLATFORM_ADMIN_PASSWORD` create the first platform administrator at start-up): list hospitals, set one up (facility, owner login and first
  administrator, who must choose a password at first sign-in), rename, suspend or reactivate it, and give its administrator a new login.
  Everything it does is recorded in `PlatformAudit`. A platform token never opens a hospital's data, and a staff session never opens the console.

## The migration that merged them (`20261021150856_stage2_hospital_merge`)

Additive: no M1 table or column was removed or renamed. It adds the hospital tables, sign-in safeguards on `User`, status and contact fields on
`Facility`, and `yearOfBirth` and `updatedAt` on `Patient`; converts the earlier hospital timestamps to `timestamptz` (read as UTC); adds the
checks and indexes OSHealth relied on (one active ward-medicine schedule per prescription, no duplicate supplier invoice, one bed charge per bed
day ...); installs the per-hospital numbering (`next_facility_number`, `assign_facility_number` triggers); gives existing patients their MRN in
registration order; and gives every existing login a staff record.

## Configuration

All optional; see `backend/.env.example` ("Hospital modules"). The ones that matter in production:

- `FILE_STORE`: uploads are switched off in production until a persistent store is chosen (see [DOCUMENTS.md](hospital/DOCUMENTS.md)).
- `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`: the consultation assistant and discharge drafts; the screens work without them.
- `PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD`: only where the platform console is used.

The Docker image includes `backend/reference/drug-catalog.tsv.gz` (the Indian brand list the prescribing and pharmacy screens search).

## Scripts (in `backend/`)

| Command | What |
|---|---|
| `npm run seed:demo` | Local development only: a demo facility and administrator (M1) plus a working hospital: staff of every role with logins (`renu@`, `sunita@`, `priya@`, `mohit@`, `kavita@`, `geeta@`, `anita@`, `arjun@` the staff e-mail's domain, same password), beds, pharmacy stock, panels, example price lists, patients, visits, supplies, waste, roster, attendance. The password is `SEED_PASSWORD` or a generated one saved to `backend/.local-credentials.txt`. No ABHA is made up: link them through the M1 screens. |
| `npm run seed:masters [HFR ID]` | Example price lists (ward rates, services, tests with ranges, templates) for a hospital that has none. Replace the prices under Masters. |
| `npm run ai:check` | One tiny made-up request to the configured AI service: checks the key and model. |
| `npm test` | The M1 tests (against a running backend, `TEST_API`). |
| `npm run test:hospital` | The hospital tests (start the application themselves). They write a lot and refuse to run unless `DATABASE_URL` is a local PostgreSQL. |

## What changed from OSHealth in the merge

- **Logins are e-mail addresses**, and there is one login screen for everything (OSHealth signed in by username and hospital code).
- **ABDM:** OSHealth's ABDM module (a simulator) is replaced by this application's certified M1 integration. A patient's `abhaStatus` and ABHA
  number on the hospital screens come from the M1 link (`AbhaPatient`). A patient's name cannot be edited on the hospital screens once an ABHA is
  linked (`409 NAME_FROM_ABHA`): it comes from the ABHA.
- **Several hospitals** live in one schema (a `facilityId` on every row) instead of one PostgreSQL schema per hospital.
- **Fixes made while merging:** the pharmacy queue reports medicines that are not on the hospital's list as unlisted (not "out of stock");
  deactivating a staff member ends their sessions and drops a pending password-reset request, and a deactivated person cannot request one; an
  empty "forgot password" request is refused; the hospital rate limits cannot be switched off in production; the AI tests can never use a
  developer's real AI key.

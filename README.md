# HMS – ABHA Integration (ABDM M1)

A hospital management system (HMS) with a complete **ABDM Milestone 1 (M1)** integration, and the hospital modules (OPD, emergency, IPD, pharmacy, lab and radiology, billing, staff) merged in from AIVA OSHealth (see [docs/HOSPITAL_MODULES.md](docs/HOSPITAL_MODULES.md), [docs/MERGE_AUDIT.md](docs/MERGE_AUDIT.md)): creating and verifying
**ABHA** (Ayushman Bharat Health Account) numbers and addresses, linking them to hospital patients, and receiving
patients' shared profiles through **Scan & Share**. It is built against the ABDM **V3** APIs and the NHA
"ABHA Creation and Verification" assessment sheet.

| | |
|---|---|
| **Backend** | Node.js, Express 5, TypeScript, Prisma, PostgreSQL |
| **Frontend** | React 19, TypeScript, Vite, Zustand |
| **ABDM** | V3 sandbox and production endpoints, RSA-OAEP encrypted Aadhaar / mobile / OTP values, HIE-CM gateway callbacks |

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Getting started](#getting-started)
5. [Configuration](#configuration)
6. [Scan & Share setup](#scan--share-setup)
7. [Security](#security)
8. [NHA M1 assessment status](#nha-m1-assessment-status)
9. [Deployment](#deployment)
10. [Documentation](#documentation)

---

## Features

### ABHA creation
- Create an ABHA with **Aadhaar OTP**, with the ABDM consent text shown in **English and Hindi** and recorded per transaction.
- Aadhaar validation with specific error messages, OTP **resend limited to 2 times after 60 seconds**.
- Communication mobile number: used directly when it is the Aadhaar-linked one, otherwise verified by a second OTP.
- **ABHA address** choice from at least 3 ABDM suggestions, or a custom address following the NHA policy (8–18 characters, rules shown beside the field).
- ABHA number shown on the success screen; **ABHA card / QR** viewable and downloadable from the patient record.

### Linking an existing ABHA
Four ways to find and link an ABHA to a patient, each with the OTP going to the Aadhaar-linked mobile or the ABHA-registered mobile:

| Method | Notes |
|---|---|
| Aadhaar number | Aadhaar OTP |
| Mobile number | Lists the ABHA accounts on that number; "no ABHA found" is reported distinctly |
| ABHA number | OTP via Aadhaar or ABHA mobile |
| ABHA address | PHR login, supports `@sbx` / `@abdm`; the supported OTP channels are checked before an OTP is sent |

Every failure is reported specifically (wrong OTP, expired OTP, cool-down, too many attempts, Aadhaar without a mobile, inactive account, ABHA not found), never as a generic error.

### Identity safety
- **Name and date-of-birth matching** between the hospital record and the ABHA profile when linking. The ABHA is the verified source: a name or date of birth that differs is replaced by the ABHA's, and the patient record shows a note with the previous values.
- An ABHA (or Aadhaar) that already belongs to a patient of this hospital opens that patient's record instead of creating a second one.
- **One ABHA per patient**, enforced by a unique database constraint, for new and existing patients.
- Gender, address, state and district are filled from the ABHA profile where the record is empty; name, date of birth and gender are then fixed.
- Optional **update of the ABHA mobile number / email** (OTP to the new value) and a prompt when the ABHA mobile differs from the hospital record.

### Scan & Share
Patients scan a counter QR code in their PHR app and share their profile. The HMS receives it from ABDM, hands back a **queue token** (valid 30 minutes, sequential per counter per day), and staff register the patient from a **Shared profiles** screen. See [Scan & Share setup](#scan--share-setup).

### Staff application
Staff and facility-owner logins, facility setup (ABDM client ID and secret, stored encrypted), a dashboard, patient registration and register, patient record with live ABHA profile, and the Scan & Share queue.

### Hospital modules
One sign-in, and each person sees the screens of their role (front office, doctor, nurse, pharmacist, billing, lab, housekeeping, administrator): OPD billing and queue, consultations (SOAP note, vitals, prescriptions, orders, an AI assistant that only ever drafts), emergency with triage, IPD bed board, housekeeping and bio-medical waste, the ward medicine round, pharmacy (stock, counter sales, purchases, GST), lab and radiology (worklist, signed reports, critical values), OPD and IPD billing with panels, discounts and refunds, masters (price lists), supplies, roster and payroll, staff access, audit log, and the platform console for setting hospitals up. Several hospitals can share one installation; their data never mixes. Details: [docs/HOSPITAL_MODULES.md](docs/HOSPITAL_MODULES.md).

---

## Architecture

```
 Staff browser ──▶ React app ──▶ Express API ──▶ PostgreSQL (Prisma)
                                      │  ▲
                 ABHA enrolment / profile APIs  │  callbacks (Scan & Share)
                                      ▼  │
                               ABDM V3 gateway ◀── patient's PHR app
```

- The browser never talks to ABDM. The backend holds the facility's credentials, obtains the gateway token, and encrypts sensitive values with ABDM's public certificate.
- An ABHA session token (X-token) is bound to **one patient** through signed, httpOnly cookies, and it is a PHR token when the login was by ABHA address, so features not allowed on a PHR token explain why.
- ABDM → HMS callbacks (`/api/v3/hip/patient/share`) are public routes protected by verifying the RS256 signature of ABDM's bearer token, not by staff login.

---

## Repository layout

```
backend/
  prisma/                 schema and migrations
  scripts/                seed_demo.ts, seed_masters.ts, ai_check.ts, register_bridge.ts, local_gateway.ts
  src/
    common/               ABDM clients, middlewares, validators, utilities
    integration/Abha/
      m1/                 ABHA creation / verification routes, controller, service
    hospital/             the hospital modules (/api/v1): OPD, IPD, pharmacy, lab, billing, staff ... plus the platform console
      share/              Scan & Share (callback, staff queue)
    modules/              facility, users/admin, patients, dashboard
  tests/                  M1 API tests (node:test) against a running backend
  tests/hospital/         the hospital tests (start the application themselves; local database only): npm run test:hospital
frontend/
  src/
    pages/                Sign in, Facility setup, Dashboard, Patients, Register, Patient record, Scan & Share
    hospital/             the merged hospital modules: screens (modules/), API calls (api/), data store (store/), styles (styles/)
    components/           app shell, UI kit, consent box, create follow-ups, contact update, ABHA profile
    api/                  typed API layer and ABDM session refresh
    lib/                  consent text (EN/HI), ABHA rules, mobile-number rules, error mapping
    styles/hms.css        the design system (one stylesheet)
docs/                     NHA self-assessment sheet, remaining-features report, Cloud Run guide
render.yaml               Render blueprint (API + static site)
```

---

## Getting started

**Requirements:** Node.js 20 or newer, PostgreSQL (a local database or a hosted one such as Neon), and ABDM **sandbox** client credentials for the facility.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env          # then fill in the values (see Configuration)
npx prisma migrate deploy
npx prisma generate
npm run dev                   # http://localhost:5000, health check at /health
```

Optional, **local development only**: create a demo facility, administrator and a working demo hospital (staff of every role with logins, beds, stock, price lists, patients, visits). The script refuses to run when `NODE_ENV=production`. It uses `SEED_PASSWORD` if given, otherwise generates one into the git-ignored `backend/.local-credentials.txt`.

```bash
npm run seed:demo
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5180 (port set in vite.config.ts)
```

The Vite dev server proxies `/api` to the backend, which keeps the httpOnly cookies same-origin.

### 3. First use

1. Sign in as the **facility owner** and add the ABDM **sandbox** client ID and secret under Facility setup, then create a staff account.
2. Sign in as **staff**, register a patient, and create or link an ABHA from the registration screen.

> `prisma generate` fails with `EPERM` on Windows while a backend process is running. Stop the backend, generate, and start it again.

---

## Configuration

### Backend (`backend/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `FACILITY_ACCESS_TOKEN_SECRET`, `FACILITY_REFRESH_TOKEN_SECRET` | yes | Signing secrets for facility logins |
| `USER_ACCESS_TOKEN_SECRET`, `USER_REFRESH_TOKEN_SECRET` | yes | Signing secrets for staff logins (the ABHA cookie signing key is derived from the access secret) |
| `ABDM_ENCRYPTION_KEY` | yes | Encrypts the stored ABDM client secrets |
| `SANDBOX_SESSION_URL`, `PROD_SESSION_URL` | yes | Gateway session endpoints (`…/api/hiecm/gateway/v3/sessions`) |
| `FRONTEND_URL` | production | Exact frontend origin allowed by CORS and the CSRF check |
| `PORT` | no | Defaults to `5000` |
| `SANDBOX_GATEWAY_URL`, `PROD_GATEWAY_URL` | no | HIE-CM base URLs (default `https://dev.abdm.gov.in/api/hiecm` and `https://live.abdm.gov.in/api/hiecm`) |
| `SHARE_QR_SANDBOX_URL`, `SHARE_QR_PRODUCTION_URL` | no | Host used in counter QR codes (production host to be confirmed with NHA) |
| `ABDM_AUDIT_LOG` | no | `true` logs ABDM request metadata for assessment evidence |
| `ABDM_SKIP_CALLBACK_JWT` | no | `true` skips callback signature checks. **Development only**, ignored when `NODE_ENV=production` |

Use long random values for every secret and never reuse them across environments.

### Frontend (`frontend/.env`)

| Variable | Purpose |
|---|---|
| `VITE_ABDM_ENVIRONMENT` | `SANDBOX` (default) or `PRODUCTION` |
| `VITE_API_URL` | Backend URL when it is on a different origin than the frontend (deployed setup). Leave unset locally to use the proxy |

---

## Scan & Share setup

ABDM can only reach a **public HTTPS** address, so `localhost` does not work for this feature.

1. Expose the backend: deploy it, or for sandbox testing use a tunnel, for example `cloudflared tunnel --url http://localhost:5000`.
2. Register the URL with ABDM, once per environment and again whenever it changes:

   ```bash
   cd backend
   npx tsx scripts/register_bridge.ts <facility HFR id> SANDBOX https://<public-backend-url>
   ```

   `PATCH /gateway/v3/bridge/url` replaces the callback URL for the **whole client ID**; use a client ID no other system shares. The script also prints whether the HFR ID is an active HIP.
3. In the app open **Shared profiles**, enter a counter ID (for example `OPD1`) and print its QR code. The QR encodes
   `https://phrsbx.abdm.gov.in/share-profile?hip-id=<HFR id>&counter-id=<counter>`.
4. A patient scans it in their PHR app and shares. The profile appears in the queue within seconds with its token and a 30-minute countdown. Staff choose **Register patient** (creates the patient and links the ABHA, no OTP needed because the patient consented in their own app) or **Dismiss**.

Behaviour worth knowing: scanning again within 30 minutes returns the same token; if the ABHA is already linked to a patient the existing patient is opened instead of creating a duplicate; unclaimed shares are deleted shortly after they expire.

---

## Security

The implementation follows the NDHM secure-development guidelines:

- **CSRF defence:** JSON-only state-changing requests plus an `Origin` check; `SameSite` cookies in production.
- **Rate limiting:** per-IP and per-account login limits, OTP route limits, a global API limiter with `RateLimit-*` headers.
- **Authentication:** JWTs pinned to HS256, httpOnly cookies, timing-safe login, password policy (10–128 characters, letters and digits, weak-password list).
- **Callbacks:** ABDM's bearer token must be a valid RS256 JWT verified against the gateway's published keys, for a facility we serve; fail-closed, rejections are logged.
- **Data protection:** ABDM client secrets encrypted at rest; Aadhaar, mobile and OTP values encrypted for ABDM and never logged; `Cache-Control: no-store` on the API; shared profiles purged on expiry.
- **Audit and logging:** an ABHA audit trail (metadata only) and structured JSON security logs; no request bodies, tokens or personal data in logs.
- **Input validation** with zod on every route; security headers via Helmet.

---

## NHA M1 assessment status

Tracked against `docs/M1_ABHA_Assessment_Self-Check.xlsx`.

- **Mandatory features:** all built: ABHA creation by Aadhaar OTP, consent, resend rules, mobile verification, address suggestions, card view/download, verification by ABHA number / ABHA address / mobile / Aadhaar, one ABHA per patient, Scan & Share.
- **Optional, built:** multilingual consent (Hindi), ABHA mobile and email update.
- **Optional, not built:** Aadhaar biometric flows, photo update, re-KYC, delete ABHA, reading an ABHA QR code, password login, child ABHA, Driving Licence / PAN creation.
- **Still to verify live:** Scan & Share against the real sandbox (it needs a public URL).

The spreadsheet in `docs/` holds the earlier statuses and is refreshed after live testing.

---

## Deployment

`render.yaml` defines a Render blueprint: a Node web service for the API (runs `prisma migrate deploy` before start, health check at `/health`) and a static site for the frontend with security headers. Checklist:

- Set `NODE_ENV=production`, the V3 session URLs, fresh secrets and the exact `FRONTEND_URL`.
- Set `VITE_API_URL` on the frontend to the API's URL.
- Do not run the demo seed in production; there are no default accounts.
- Free instances sleep when idle, which can miss ABDM's 30-second callback window; use an always-on instance for Scan & Share and the assessment.

---

## Documentation

- [`backend/README.md`](backend/README.md): full API reference (endpoints, requests, behaviour)
- [`frontend/README.md`](frontend/README.md): frontend structure, screens and design system
- [`docs/M1_ABHA_Assessment_Self-Check.xlsx`](docs/M1_ABHA_Assessment_Self-Check.xlsx): row-by-row NHA assessment
- [`docs/M1_Remaining_Features.pdf`](docs/M1_Remaining_Features.pdf): features left, by priority
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contribution guidelines

# HMS---ABHA-INTEGRATION

## API endpoints

The API runs on port `5000` by default. Unless noted otherwise, request and response
bodies use JSON. Authenticated routes require the relevant `httpOnly` cookie set by
the login endpoint; the backend also accepts a bearer token in the `Authorization`
header. Successful responses generally contain `success`, `message`, and (when
applicable) `data`. Errors contain a message.

### Hospital modules (`/api/v1`)

OPD, emergency, IPD, beds, pharmacy, lab and radiology, billing, masters, staff, roster, payroll, supplies, waste, the AI assistant, the audit log and the platform console are under `/api/v1`, with their own error format (`{ "error": { "code", "message" } }`). They use the same login and cookie, and the signed-in person's role decides what is allowed. See [`docs/HOSPITAL_MODULES.md`](../docs/HOSPITAL_MODULES.md) and [`docs/hospital/`](../docs/hospital/).

### Health

| Method | Endpoint | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | None | Check that the API is running. |

### Facility

| Method | Endpoint | Authentication | Request body | Purpose |
|---|---|---|---|---|
| `POST` | `/api/facility/register` | None | `{ "name", "email", "hfrId", "password" }` | Register a facility. Name: 3–20 characters; password: 8–20 characters. |
| `POST` | `/api/facility/login` | None | `{ "email", "password" }` | Log in as a facility; sets the facility `accessToken` and `refreshToken` cookies. |
| `POST` | `/api/facility/logout` | Facility | None | Log out the facility and clear its cookies. |
| `POST` | `/api/facility/add-abdm-details` | Facility | `{ "clientId", "clientSecret", "environment": "SANDBOX" | "PRODUCTION" }` | Save ABDM credentials for the facility. |
| `POST` | `/api/facility/create-admin` | Facility | `{ "name", "email", "password" }` | Create a staff/admin login under this facility. Name: 3–20 characters; password: 6–20 characters. |

### Staff/admin

| Method | Endpoint | Authentication | Request body | Purpose |
|---|---|---|---|---|
| `POST` | `/api/user/admin/login` | None | `{ "email", "password" }` | Log in as staff/admin (the one login for the M1 routes and the hospital modules); sets the user `accessToken` and `refreshToken` cookies. Returns `id`, `name`, `email`, `facilityName`, `role`, `staffId`, `department` and `mustChangePassword` (a new or reset login must choose its own password first: `403 PASSWORD_CHANGE_REQUIRED` elsewhere). Five wrong passwords lock the login for 15 minutes (`429 ACCOUNT_LOCKED`); a suspended hospital gets `403 HOSPITAL_SUSPENDED`. |
| `POST` | `/api/user/admin/logout` | Staff/admin | None | Log out and clear the user cookies. |

### Patients

| Method | Endpoint | Authentication | Request body | Purpose |
|---|---|---|---|---|
| `POST` | `/api/patient/create` | Staff/admin | `{ "name", "phone", "email?", "dateOfBirth?", "gender?" (M, F or O) }` | Create a patient for the authenticated user's facility. Phone must be 10 digits. |
| `GET` | `/api/patient` | Staff/admin | None | Return patients belonging to the authenticated user's facility, including their ABHA record when present.|
| `PATCH` | `/api/patient/:patientId` | Staff/admin | `{ "phone?", "email?", "address?", "stateName?", "districtName?" }` | Edit contact and address. Name, date of birth and gender are fixed once verified against an ABHA. |
| `DELETE` | `/api/patient/:patientId` | Staff/admin | None | Testing aid: permanently remove the patient, their ABHA link and ABHA transactions. Nothing is deleted at ABDM. |
| `GET` | `/api/patient/:patientId/transactions` | Staff/admin | None | Return that patient's ABHA transactions for the authenticated facility, newest first.|

### Dashboard

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/dashboard` | Staff | Counts for the dashboard: patients, with/without an ABHA, registered today (IST), shared profiles waiting, and the last 8 ABHA audit entries (action, outcome, error code; no personal data). |

### ABHA / ABDM M1

All routes below require staff/admin authentication. `environment` must be `SANDBOX` or `PRODUCTION`.
ABDM gateway tokens last 20 minutes; when a route answers `401 ABDM authentication required`, call `/api/abha/retrieve` again and retry.

| Method | Endpoint | Request | Purpose |
|---|---|---|---|
| `POST` | `/api/abha/retrieve` | body `{ environment }` | Get ABDM session tokens (httpOnly cookies used by the other routes). |
| `POST` | `/api/abha/create/aadhar/request` | body `{ patientId, aadhaar, environment }` | Send an Aadhaar OTP to create a new ABHA. |
| `POST` | `/api/abha/create/aadhar/verify` | body `{ transactionId, otp, mobile, environment }` | Verify the OTP, create the ABHA and link it to the patient. |
| `POST` | `/api/abha/verify/aadhar/request` | body `{ patientId, aadhaar, environment }` | Send an Aadhaar OTP to link an existing ABHA. |
| `POST` | `/api/abha/verify/aadhar/confirm` | body `{ transactionId, otp, environment }` | Verify the OTP and link the existing ABHA. |
| `POST` | `/api/abha/verify/mobile/request` | body `{ patientId, mobile, environment }` | Send a mobile OTP to find existing ABHA accounts. |
| `POST` | `/api/abha/verify/mobile/confirm` | body `{ transactionId, otp, environment }` | Verify the OTP; returns the account list. |
| `POST` | `/api/abha/verify/mobile/user` | body `{ abhaNumber, transactionId, environment }` | Choose an account and link it to the patient. |
| `POST` | `/api/abha/create/mobile/request` | body `{ transactionId, mobile, environment }` | After creating an ABHA: send an OTP to verify the mobile number to link (when it is not the Aadhaar-linked one). |
| `POST` | `/api/abha/create/mobile/verify` | body `{ transactionId, otp, environment }` | Verify that OTP. |
| `GET` | `/api/abha/create/address/suggestions` | query `transactionId, environment` | ABHA address suggestions for the new ABHA. |
| `POST` | `/api/abha/create/address` | body `{ transactionId, abhaAddress, environment }` | Create the chosen ABHA address (4–18 chars, at most one `.` and one `_`). |
| `POST` | `/api/abha/verify/number/request` | body `{ patientId, abhaNumber, channel, environment, consent }` | Link by ABHA number; `channel` is `aadhaar` or `mobile` (where the OTP goes). |
| `POST` | `/api/abha/verify/number/confirm` | body `{ transactionId, otp, channel, environment }` | Verify the OTP and link the ABHA. |
| `GET` | `/api/abha/profile/card` | query `patientId, environment` | Download the ABHA card (PNG/PDF). Same session restriction as the QR. |
| `GET` | `/api/abha/audit` | query `patientId?` | ABHA audit trail for the facility (who, action, outcome, error code, IP; no personal data). |
| `GET` | `/api/abha/profile` | query `patientId, environment` | Live ABHA profile. Only works for the patient whose ABHA was verified in this session. |
| `POST` | `/api/abha/verify/address/request` | body `{ patientId, abhaAddress, channel, environment, consent }` | Link by ABHA address (PHR login). `channel` is `aadhaar` or `mobile`. A bare name gets `@sbx` / `@abdm` added. |
| `POST` | `/api/abha/verify/address/confirm` | body `{ transactionId, otp, channel, environment }` | Verify the OTP and link the ABHA. The session token from this login is a PHR token: profile and card work, the QR and mobile/email update do not. |
| `GET` | `/api/abha/profile/qr` | query `patientId, environment` | Live ABHA QR image, same restriction as the profile. |

Every OTP-request route also needs `consent: true` (the patient accepted the consent text). `patientId` and `transactionId` must be UUIDs. ABDM/UIDAI validation messages (wrong Aadhaar, wrong OTP, 30-second
OTP cool-down) are returned as-is with status 400/422/429.

Every route that links an ABHA (`create/aadhar/verify`, `verify/*/confirm`, `verify/mobile/user`) also returns:
- `patientId`: the patient the ABHA is linked to. When the ABHA already belonged to another patient of this facility, that patient's id is
  returned with `alreadyRegistered: true` (a blank record created only for this attempt is removed). An ABHA linked at another facility is
  refused with `409 ABHA_LINKED_TO_OTHER_PATIENT`.
- `detailsUpdated`: `"name"` and/or `"date of birth"` when the values on the record differed from the ABHA and were replaced by it; the
  patient's `abhaUpdateNote` then records the previous values.
- `verify/mobile/confirm` additionally returns `matchedAbhaNumbers`: the accounts whose name and date of birth agree with the patient.
- `verify/number/confirm` and `verify/address/confirm` accept an optional `requireMobileMatch: true`, which refuses the link
  (`422 ABHA_MOBILE_MISMATCH`) when the ABHA's mobile number is not the patient's.

Patients may share a mobile number. `POST /api/patient/create` accepts a body without `name` (and without `phone`) for a patient registered
from an ABHA; such a record is completed from the ABHA when it is linked.

### Scan & Share (patient shares their ABHA profile at a counter)

A patient scans the counter QR code (`<phr host>/share-profile?hip-id=<facility HFR id>&counter-id=<counter>`) in their PHR app and agrees to share.
ABDM then calls our bridge; we answer 200, store the profile for up to 30 minutes, and reply on `patient-share/v3/on-share` with a queue token
(sequential per counter per day; the same person scanning again while their token is valid gets the same token). Staff register the patient from the
"Shared profiles" screen: no OTP is needed because the patient consented in their own app. Expired, unclaimed shares are deleted.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v3/hip/patient/share` | ABDM bearer JWT (RS256, verified against the gateway keys), `X-HIP-ID` = facility HFR id | The callback ABDM makes on the bridge URL. Rejected with 401/403 and logged (`ABDM_CALLBACK_REJECTED`) unless all checks pass. |
| `GET` | `/api/abha/shares` | Staff | Shared profiles still waiting (valid token), oldest first. Includes the existing patient when the ABHA is already linked. |
| `GET` | `/api/abha/shares/config?environment=` | Staff | HFR id and QR host for printing counter QR codes. |
| `POST` | `/api/abha/shares/:shareId/register` | Staff | body `{ phone? }`. Create the patient and link the ABHA (or return the existing patient). `PHONE_REQUIRED` asks for a mobile number (a number may be shared by several patients). |
| `POST` | `/api/abha/shares/:shareId/dismiss` | Staff | Delete a shared profile without registering it. |

Setup (once per environment, and again whenever the public URL changes): the backend must be reachable on public HTTPS (a deployed URL, or a tunnel for
sandbox testing), then run

```
npx tsx scripts/register_bridge.ts <facility HFR id> SANDBOX https://<public backend url>
```

`PATCH /gateway/v3/bridge/url` replaces the callback URL for the **whole client id**, so use a client id that no other system shares. Optional env vars:
`SANDBOX_GATEWAY_URL` / `PROD_GATEWAY_URL` (default `https://dev.abdm.gov.in/api/hiecm` / `https://live.abdm.gov.in/api/hiecm`),
`SHARE_QR_SANDBOX_URL` / `SHARE_QR_PRODUCTION_URL` (QR host; the production host is to be confirmed with NHA at onboarding), and, for local development only,
`ABDM_SKIP_CALLBACK_JWT=true` (accepts any bearer token; ignored when `NODE_ENV=production`).

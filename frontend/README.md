# AIVA OSHealth: Staff Web App (Frontend)

React 19 + TypeScript + Vite staff application for the HMS ABHA-integration backend. It covers
facility setup, patient registration, the full ABDM M1 ABHA flows, the patient record, the
Scan & Share queue. The hospital modules (OPD, emergency, IPD, pharmacy, lab, billing, staff ...) live under `src/hospital` and show the screens of the signed-in role. See the [root README](../README.md)
for the project overview and the [backend README](../backend/README.md) for the API.

## Run

Requirements: Node.js 20 or newer, and the backend running (see the root README).

```bash
npm install
npm run dev       # http://localhost:5180 (port set in vite.config.ts; override with --port)
```

`npm run dev` proxies `/api` to `http://localhost:5000` (see `vite.config.ts`), so the httpOnly login
cookies stay same-origin. Other scripts: `npm run build` (type-check and production build),
`npm run preview`, `npm run lint` (oxlint).

## Configuration

Copy `.env.example` to `.env`.

| Variable | Where | Purpose |
|---|---|---|
| `BACKEND_URL` | dev/preview server | Proxy target for `/api` (default `http://localhost:5000`) |
| `VITE_ABDM_ENVIRONMENT` | browser | `SANDBOX` (default) or `PRODUCTION` for ABHA calls |
| `VITE_API_URL` | browser | Backend URL when the API is on another origin, as in a deployed setup. The backend's `FRONTEND_URL` must then include this app's exact origin |

## Using the app

There are two kinds of login, and they share one cookie, so only one is active at a time.

1. **Register a facility** at `/login`, then sign in as the **facility owner**. This lands on **Facility setup**: save the
   ABDM client ID and secret (sandbox or production).
2. Sign out and sign in as **staff**. A facility login sees only Facility setup; a staff login sees only the hospital screens.

| Screen | Route | Notes |
|---|---|---|
| Sign in | `/login` | Staff, facility owner, register a facility |
| Facility setup | `/facility-setup` | Facility login only |
| Dashboard | `/` | Live counts, ABHA activity, items needing attention |
| Patient register | `/registration` | Search, ABHA filter, pagination, "Add ABHA" |
| New registration | `/register` | Existing ABHA, new ABHA (Aadhaar), or manual registration |
| Patient record | `/record/:patientId` | Demographics, live ABHA profile, QR, card, contact update |
| Scan & Share queue | `/shared-profiles` | Shared profiles waiting and counter QR codes |
| Hospital modules | `/opd`, `/opd-billing`, `/emergency`, `/ipd`, `/pharmacy`, `/lab`, `/billing`, `/masters`, `/roster`, `/payroll`, `/access`, `/audit` ... | The merged hospital screens (`src/hospital/modules`), loaded on demand, limited by role; `/platform` is the platform console |

### ABHA flows (New registration)

- **Existing ABHA**: search by ABHA number or address, or by mobile or Aadhaar number, then OTP. Several ABHAs on one
  mobile number are offered as a list (the one matching the patient's name is picked automatically when known).
- **New ABHA** with Aadhaar and mobile number. The consent text is shown in English or Hindi and must be accepted before any OTP
  is sent. Afterwards: verify the mobile if it is not the Aadhaar one, and set a custom ABHA address (or one is generated).
- **Manual registration** with name, date of birth and mobile number; an ABHA can be added later from the record.
- When an ABHA is linked, a name or date of birth that differs from it is replaced by the ABHA's and noted on the record.
  An ABHA already linked to a patient here opens that patient's record.
- OTP resend is limited to 2 times after 60 seconds. Every error carries a specific title and message, mapped in `src/lib/errorHelper.ts`.

### Scan & Share

Shows patients who scanned a counter QR code and shared their ABHA profile, each with a token and a 30-minute countdown, refreshed
every 10 seconds. **Register** creates the patient and links the ABHA (it asks for a mobile number if the shared profile has none);
**Dismiss** removes the entry after confirmation. The **Counter QR code** panel prints one QR per counter ID (1 to 20 letters or digits).
Setup of the public URL and bridge is in the root README.

## Things to know

- **Aadhaar numbers are never stored** by the frontend; they live in component state until the OTP is sent.
- **Sessions expire.** The next request answered "unauthorized" sends you back to `/login`. ABDM tokens are short-lived and refreshed
  in the background (`src/api/abdmSession.ts`); a lapsed ABHA verification asks you to verify the ABHA again.
- A patient whose ABHA was linked through **ABHA address login** has a PHR session: profile and card work, the QR code and
  mobile/email update do not, and the screen says why.
- Gender chosen during manual registration is **not saved yet**: the backend's create-patient endpoint does not accept it. Gender is
  filled in from the ABHA when one is linked.

## Code layout

```
src/
  main.tsx, App.tsx         start-up and all routes
  pages/                    one file per routed screen (SignIn, FacilitySetup, Dashboard, PatientList, RegisterPatient,
                            PatientRecord, SharedProfiles)
    ErrorStates.tsx         StopState: inline error / pending / empty block used by the ABHA flows
  components/
    AppShell.tsx            sidebar (the menu follows the signed-in role), top bar, breadcrumbs, user menu (change password, sign out)
    ui/kit.tsx              PageHeader, Card, Alert, StatusBadge, EmptyState, skeletons, confirmation dialog
    ConsentBox, CreateFollowUps, ContactUpdate, AbhaProfileDetails   ABHA building blocks
    auth/RequireSession     keeps logged-out users off the app
  api/
    client.ts               fetch wrapper (cookies, JSON-only, ApiError with a stable code)
    endpoints.ts            every backend route, typed: the one file to update when the API changes
    abdmSession.ts          ABDM session refresh
  lib/                      consent text (EN/HI), ABHA rules, mobile-number rules, error mapping, OTP wording, session
  store/useAuthStore.ts     login state
  styles/hms.css            the design system: tokens, shell, components (the only stylesheet)
```

Imports use `@/` for `src/`.

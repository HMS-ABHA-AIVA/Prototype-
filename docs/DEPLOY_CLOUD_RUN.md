# Deploying the backend on Google Cloud Run (Mumbai)

**Why:** ABDM's sandbox refuses servers hosted outside India (HTTP 403 "Request blocked" from its CDN). The Render service in Singapore hits
that. Cloud Run in **`asia-south1` (Mumbai)** does not. The database can stay where it is (Neon, Singapore).

All commands are for Windows PowerShell, run from the repository root unless stated.

## 0. What you need
- A Google account and a **billing account** (a card is required even for the free tier).
- Your current backend values (the ones from Render's Environment tab or `backend/.env`).

## 1. Install the tools and sign in
```powershell
winget install --id Google.CloudSDK
```
Close and reopen PowerShell, then:
```powershell
gcloud auth login
gcloud billing accounts list
```
Note the `ACCOUNT_ID` of your billing account.

## 2. Create the project and turn on the services
```powershell
gcloud projects create hms-aiva-abha --name "HMS ABHA"
gcloud config set project hms-aiva-abha
gcloud billing projects link hms-aiva-abha --billing-account=ACCOUNT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```
If the project id `hms-aiva-abha` is taken, choose another and use it everywhere below.

## 3. Write the environment file (never commit it)
Create `backend\env.cloudrun.yaml` (it is git-ignored and docker-ignored). One `KEY: 'value'` per line; keep the quotes:

```yaml
NODE_ENV: 'production'
DATABASE_URL: 'postgresql://...your Neon connection string...'
FACILITY_ACCESS_TOKEN_SECRET: '...'
FACILITY_REFRESH_TOKEN_SECRET: '...'
USER_ACCESS_TOKEN_SECRET: '...'
USER_REFRESH_TOKEN_SECRET: '...'
ABDM_ENCRYPTION_KEY: '...same value as before, so saved ABDM secrets stay readable...'
SANDBOX_SESSION_URL: 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions'
PROD_SESSION_URL: 'https://live.abdm.gov.in/api/hiecm/gateway/v3/sessions'
FRONTEND_URL: 'https://hms-aiva.vercel.app'
```
Use the same values as on Render. `FRONTEND_URL` is your Vercel address with no path and no trailing slash.

## 4. Deploy
For a clean build of exactly what is on GitHub (recommended), deploy from a fresh copy:
```powershell
git clone https://github.com/HMS-ABHA-AIVA/HMS.git $env:TEMP\hms-deploy
Copy-Item backend\env.cloudrun.yaml $env:TEMP\hms-deploy\backend\env.cloudrun.yaml
cd $env:TEMP\hms-deploy
```
(or simply stay in your working copy to deploy what is on your disk). Then:
```powershell
gcloud run deploy hms-api --source backend --region asia-south1 --allow-unauthenticated --env-vars-file backend/env.cloudrun.yaml --no-cpu-throttling --memory 512Mi --cpu 1 --max-instances 3 --timeout 60
```
The first run asks to create an Artifact Registry repository: answer `Y`. The build takes a few minutes. At the end it prints
`Service URL: https://hms-api-xxxxxxxx-el.a.run.app`.

| Flag | Why |
|---|---|
| `--region asia-south1` | Mumbai: the point of the move |
| `--allow-unauthenticated` | The app and ABDM must reach it; the app does its own sign-in |
| `--no-cpu-throttling` | Scan & Share answers ABDM first and registers afterwards; without this, Cloud Run freezes the CPU once the answer is sent |
| `--max-instances 3` | Caps cost; the in-memory rate limiters assume few instances |

## 5. Check it
```powershell
curl.exe https://hms-api-xxxxxxxx-el.a.run.app/health
```
It should answer `{"status":"ok",...}`. Then, in the deployed app, try **Send OTP** again. The ABDM block should be gone.
If it fails, read the logs:
```powershell
gcloud run services logs read hms-api --region asia-south1 --limit 50
```

## 6. Point everything at the new address
1. **Vercel:** set `VITE_API_URL` to `https://hms-api-xxxxxxxx-el.a.run.app/api` and redeploy the frontend.
2. **ABDM bridge** (Scan & Share), from your computer:
   ```powershell
   cd backend
   npx tsx scripts/register_bridge.ts <HFR id> SANDBOX https://hms-api-xxxxxxxx-el.a.run.app
   ```
3. When everything works, suspend the Render service so there is only one backend.

## 7. Day to day
- **Redeploy after a code change:** repeat the `gcloud run deploy ...` command (add `--env-vars-file` only if values changed).
- **Change one value:** `gcloud run services update hms-api --region asia-south1 --update-env-vars KEY=value`
- **Database migrations** run from your computer, as before: `cd backend; npx prisma migrate deploy`.
- **Cold starts:** with no traffic the service scales to zero and the first request takes a few seconds. For the NHA assessment keep one instance warm:
  `gcloud run services update hms-api --region asia-south1 --min-instances 1`
- **Cost:** the free tier covers light use; a warm instance costs a few dollars a month. Check Billing → Reports.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Build fails at `prisma generate` | Missing `prisma.config.ts` / `prisma` folder in the build context |
| `Container failed to start` | A required environment variable is missing; read the logs |
| Login works but you are signed out on the next page | `FRONTEND_URL` is not exactly the Vercel address |
| Still `ABDM_REGION_BLOCKED` | The service is not in `asia-south1`; check `gcloud run services describe hms-api --region asia-south1` |
| Scan & Share share arrives but no token reply | `--no-cpu-throttling` missing |

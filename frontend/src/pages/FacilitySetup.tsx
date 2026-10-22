import { useState } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { OwnerShell } from "../components/AppShell";
import { useAuthStore } from "@/store/useAuthStore";
import { addAbdmDetails, createStaffAccount } from "@/api/endpoints";
import { Alert, Card, PageHeader } from "@/components/ui/kit";

export function FacilitySetup() {
  const session = useAuthStore((s) => s.session);
  const facilityName = session?.kind === "facility" ? session.name : "";
  const hfrId = session?.kind === "facility" ? session.hfrId : "";

  const [env, setEnv] = useState<"Sandbox" | "Production">("Sandbox");

  // ABDM credentials form
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credLoading, setCredLoading] = useState(false);
  const [credSuccess, setCredSuccess] = useState<string | null>(null);
  const [credError, setCredError] = useState<string | null>(null);

  // Staff account form
  const [staffName, setStaffName] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffSuccess, setStaffSuccess] = useState<string | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredError(null);
    setCredSuccess(null);

    if (!clientId.trim() || !clientSecret.trim()) {
      setCredError("Both Client ID and Client Secret are required.");
      return;
    }

    setCredLoading(true);
    try {
      await addAbdmDetails({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        environment: env.toUpperCase() as "SANDBOX" | "PRODUCTION",
      });
      // The secret is cleared from this screen after saving (never echoed back)
      setClientSecret("");
      setCredSuccess(`ABDM ${env.toLowerCase()} credentials verified and saved.`);
    } catch (err: any) {
      setCredError(err?.message || "Failed to verify and save ABDM credentials.");
    } finally {
      setCredLoading(false);
    }
  }

  async function handleAddStaff(e: React.FormEvent) {
    e.preventDefault();
    setStaffError(null);
    setStaffSuccess(null);

    if (!staffName.trim() || !staffEmail.trim() || !staffPassword.trim()) {
      setStaffError("Name, email, and password are required.");
      return;
    }

    if (staffName.trim().length < 3 || staffName.trim().length > 50) {
      setStaffError("Name must be between 3 and 50 characters.");
      return;
    }

    if (staffPassword.length < 10 || !/[A-Za-z]/.test(staffPassword) || !/\d/.test(staffPassword)) {
      setStaffError("Password must be at least 10 characters and contain letters and numbers.");
      return;
    }

    setStaffLoading(true);
    try {
      await createStaffAccount({
        name: staffName.trim(),
        email: staffEmail.trim(),
        password: staffPassword,
      });
      setStaffSuccess(`Staff account for ${staffName} created.`);
      setStaffName("");
      setStaffEmail("");
      setStaffPassword("");
    } catch (err: any) {
      setStaffError(err?.message || "Failed to create staff account.");
    } finally {
      setStaffLoading(false);
    }
  }

  return (
    <OwnerShell>
      <PageHeader title="Facility setup" subtitle={[facilityName, hfrId && `HFR ID ${hfrId}`].filter(Boolean).join(" · ")} />

      <div className="mb-4" style={{ maxWidth: 860 }}>
        <Alert tone="info">Patient registration and ABHA work require a staff sign-in. Sign out and sign in as staff when setup is complete.</Alert>
      </div>

      <div className="grid-2" style={{ maxWidth: 1040, alignItems: "start" }}>
        <Card title="ABDM credentials" icon={KeyRound} subtitle="Verified with ABDM on save · the secret is stored encrypted">
          <form onSubmit={handleSaveCredentials}>
            <div className="field">
              <span className="field-label" id="env-label">
                Environment
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="env-label">
                {(["Sandbox", "Production"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={env === v}
                    className={env === v ? "on" : ""}
                    onClick={() => {
                      setEnv(v);
                      setCredSuccess(null);
                      setCredError(null);
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="cred-id">Client ID</label>
              <input id="cred-id" className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={credLoading} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="cred-secret">Client secret</label>
              <input
                id="cred-secret"
                className="input"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                disabled={credLoading}
                autoComplete="off"
              />
              <div className="hint">Cleared from this screen after saving</div>
            </div>
            {credError && (
              <div className="mb-3">
                <Alert tone="error">{credError}</Alert>
              </div>
            )}
            {credSuccess && (
              <div className="mb-3">
                <Alert tone="success">{credSuccess}</Alert>
              </div>
            )}
            <div className="form-actions end">
              <button className="btn btn-primary" type="submit" disabled={credLoading}>
                {credLoading && <span className="spinner" aria-hidden />}
                {credLoading ? "Verifying with ABDM" : "Save credentials"}
              </button>
            </div>
          </form>
        </Card>

        <Card title="Staff accounts" icon={UserPlus} subtitle="Sign-in for each person who registers patients or works with ABHA">
          <form onSubmit={handleAddStaff}>
            <div className="field">
              <label htmlFor="sa-name">Name</label>
              <input id="sa-name" className="input" value={staffName} onChange={(e) => setStaffName(e.target.value)} disabled={staffLoading} />
              <div className="hint">3 to 50 characters</div>
            </div>
            <div className="field">
              <label htmlFor="sa-email">Email</label>
              <input id="sa-email" className="input" type="email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} disabled={staffLoading} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="sa-pw">Password</label>
              <input
                id="sa-pw"
                className="input"
                type="password"
                value={staffPassword}
                onChange={(e) => setStaffPassword(e.target.value)}
                disabled={staffLoading}
                autoComplete="new-password"
              />
              <div className="hint">At least 10 characters, with letters and numbers</div>
            </div>
            {staffError && (
              <div className="mb-3">
                <Alert tone="error">{staffError}</Alert>
              </div>
            )}
            {staffSuccess && (
              <div className="mb-3">
                <Alert tone="success">{staffSuccess}</Alert>
              </div>
            )}
            <div className="form-actions end">
              <button className="btn btn-primary" type="submit" disabled={staffLoading}>
                {staffLoading && <span className="spinner" aria-hidden />}
                {staffLoading ? "Creating" : "Add staff member"}
              </button>
            </div>
          </form>
        </Card>
      </div>
    </OwnerShell>
  );
}

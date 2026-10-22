import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Building2, CheckCircle2, KeyRound, ShieldCheck, Stethoscope, UserRound, Users } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { registerFacility } from "@/api/endpoints";
import { forgotPassword } from "@/hospital/api/auth";
import { Alert } from "@/components/ui/kit";

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signInStaff, signInFacility } = useAuthStore();

  const [tab, setTab] = useState<"staff" | "owner">("staff");
  const [isRegisteringFacility, setIsRegisteringFacility] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // Sent back here because the session ended (expired, password changed elsewhere, access removed).
  const ended = new URLSearchParams(location.search).has("ended");

  async function askForReset() {
    setError(null);
    setSuccessMsg(null);
    if (!email.trim()) {
      setError("Enter the e-mail address you sign in with, then choose \"Forgot password?\" again.");
      return;
    }
    try {
      await forgotPassword(email.trim());
      setSuccessMsg("If this address has a login, an administrator has been asked to reset its password. They will give you a temporary one.");
    } catch (err: any) {
      setError(err?.message || "The request could not be sent. Please ask an administrator.");
    }
  }

  // Facility registration fields
  const [facName, setFacName] = useState("");
  const [facHfrId, setFacHfrId] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (isRegisteringFacility) {
        if (!facName.trim() || !email.trim() || !facHfrId.trim() || !password.trim()) {
          throw new Error("All fields are required to register a facility.");
        }
        await registerFacility({
          name: facName.trim(),
          email: email.trim(),
          hfrId: facHfrId.trim(),
          password,
        });
        setSuccessMsg("Facility registered. Sign in as the facility owner to continue setup.");
        setIsRegisteringFacility(false);
        setTab("owner");
        setLoading(false);
        return;
      }

      if (tab === "staff") {
        await signInStaff(email.trim(), password);
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from || "/", { replace: true });
      } else {
        await signInFacility(email.trim(), password);
        navigate("/facility-setup", { replace: true });
      }
    } catch (err: any) {
      setError(err?.message || "Sign in failed. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  }

  const switchMode = (registering: boolean) => {
    setIsRegisteringFacility(registering);
    setError(null);
    setSuccessMsg(null);
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden>
            <Stethoscope size={17} />
          </div>
          <div className="brand-name">AIVA OSHealth</div>
        </div>
        <h2>Hospital information system with ABDM integration</h2>
        <p className="auth-lede">Registration and ABHA (ABDM M1), OPD, emergency, IPD, pharmacy, lab, billing and staff, in one application.</p>

        <ul className="auth-points">
          <li>
            <ShieldCheck size={16} aria-hidden />
            <span>ABHA flows run with patient consent and OTP verification through ABDM.</span>
          </li>
          <li>
            <Users size={16} aria-hidden />
            <span>Each person sees the screens of their role; the facility owner signs in separately for ABDM setup.</span>
          </li>
        </ul>

        <div className="auth-foot">
          <div style={{ fontWeight: 600, color: "var(--nav-text)", marginBottom: 6 }}>New hospital setup</div>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
            <li>Register the facility</li>
            <li>Sign in as facility owner and save ABDM credentials</li>
            <li>Create staff accounts</li>
            <li>Staff sign in and register patients</li>
          </ol>
        </div>
      </aside>

      <main className="auth-main">
        <form className="auth-card" onSubmit={submit} noValidate={false}>
          <h1>{isRegisteringFacility ? "Register a facility" : "Sign in"}</h1>
          <p className="auth-sub">
            {isRegisteringFacility
              ? "Create the facility owner account. Staff accounts are added after setup."
              : tab === "staff"
                ? "Hospital staff account"
                : "Facility owner account (ABDM credentials and staff accounts)"}
          </p>

          {!isRegisteringFacility && (
            <div className="seg" role="tablist" aria-label="Account type" style={{ width: "100%", marginBottom: 18 }}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "staff"}
                className={tab === "staff" ? "on" : ""}
                style={{ flex: 1 }}
                onClick={() => {
                  setTab("staff");
                  setError(null);
                }}
              >
                <span className="inline" style={{ justifyContent: "center", gap: 6 }}>
                  <UserRound size={14} aria-hidden />
                  Staff
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "owner"}
                className={tab === "owner" ? "on" : ""}
                style={{ flex: 1 }}
                onClick={() => {
                  setTab("owner");
                  setError(null);
                }}
              >
                <span className="inline" style={{ justifyContent: "center", gap: 6 }}>
                  <Building2 size={14} aria-hidden />
                  Facility owner
                </span>
              </button>
            </div>
          )}

          {successMsg && (
            <Alert tone="success" className="">
              {successMsg}
            </Alert>
          )}
          {ended && !successMsg && !error && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="info">Your session has ended. Please sign in again.</Alert>
            </div>
          )}

          {isRegisteringFacility && (
            <>
              <div className="field">
                <label htmlFor="fac-name">Facility name</label>
                <input
                  id="fac-name"
                  className="input"
                  value={facName}
                  onChange={(e) => setFacName(e.target.value)}
                  disabled={loading}
                  required
                  minLength={3}
                  maxLength={100}
                />
                <div className="hint">3–100 characters</div>
              </div>
              <div className="field">
                <label htmlFor="fac-hfr">HFR ID</label>
                <input
                  id="fac-hfr"
                  className="input mono"
                  placeholder="IN2410001234"
                  value={facHfrId}
                  onChange={(e) => setFacHfrId(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={isRegisteringFacility ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
            {isRegisteringFacility && <div className="hint">At least 10 characters, with letters and numbers</div>}
            {!isRegisteringFacility && tab === "staff" && (
              <div className="hint">
                <button type="button" className="btn-link" onClick={askForReset} disabled={loading}>
                  Forgot password?
                </button>
              </div>
            )}
          </div>

          {error && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="error">{error}</Alert>
            </div>
          )}

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={loading}>
            {loading ? <span className="spinner" aria-hidden /> : isRegisteringFacility ? <CheckCircle2 size={16} aria-hidden /> : <KeyRound size={16} aria-hidden />}
            {loading ? "Please wait" : isRegisteringFacility ? "Register facility" : "Sign in"}
          </button>

          <div style={{ fontSize: 13, marginTop: 16, color: "var(--text-2)" }}>
            {isRegisteringFacility ? (
              <>
                Already registered?{" "}
                <button type="button" className="btn-link" onClick={() => switchMode(false)}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New hospital?{" "}
                <button type="button" className="btn-link" onClick={() => switchMode(true)}>
                  Register a facility
                </button>
              </>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

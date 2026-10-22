import { useEffect, useState } from "react";
import { requestAbhaContactUpdate, verifyAbhaContactUpdate, type AbdmEnvironment } from "@/api/endpoints";
import { withAbdmSession } from "@/api/abdmSession";
import { StopState } from "@/pages/ErrorStates";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { MAX_OTP_RESENDS, OTP_RESEND_SECONDS } from "@/lib/abhaRules";

/**
 * Updates the mobile number or email held on the patient's ABHA at ABDM: an OTP goes to the NEW value, and
 * verifying it makes ABDM hold the new value. Needs the ABHA to have been verified in this session.
 */
export function ContactUpdate({
  patientId,
  type,
  environment,
  initialValue = "",
  intro,
  onDone,
  onCancel,
}: {
  patientId: string;
  type: "mobile" | "email";
  environment: AbdmEnvironment;
  initialValue?: string;
  intro?: string;
  /** Called after ABDM accepted the new value, with that value (digits only for a mobile number). */
  onDone: (value: string) => void;
  onCancel: () => void;
}) {
  const label = type === "mobile" ? "mobile number" : "email address";
  const [value, setValue] = useState(initialValue);
  const [transactionId, setTransactionId] = useState("");
  const [otp, setOtp] = useState("");
  const [otpMessage, setOtpMessage] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [resendCount, setResendCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<MappedErrorState | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const cleanValue = type === "mobile" ? value.replace(/\D/g, "") : value.trim();

  async function sendOtp(isResend = false) {
    if (isResend && resendCount >= MAX_OTP_RESENDS) return;
    setError(null);

    if (type === "mobile" && cleanValue.length !== 10) {
      setError({ tone: "error", title: "Invalid mobile number", body: "Mobile number must be exactly 10 digits." });
      return;
    }
    if (type === "email" && !/^\S+@\S+\.\S+$/.test(cleanValue)) {
      setError({ tone: "error", title: "Invalid email address", body: "Enter a valid email address." });
      return;
    }

    setBusy(true);
    try {
      const res = await withAbdmSession(environment, () =>
        requestAbhaContactUpdate(
          type === "mobile"
            ? { patientId, type: "mobile", value: cleanValue, environment }
            : { patientId, type: "email", value: cleanValue, environment },
        ),
      );
      setTransactionId(res.data.transactionId);
      setOtpMessage(res.message ?? "");
      setOtp("");
      setResendCount(isResend ? resendCount + 1 : 0);
      setResendIn(OTP_RESEND_SECONDS);
    } catch (err) {
      setError(mapApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setError(null);
    const clean = otp.replace(/\D/g, "");
    if (clean.length !== 6) {
      setError({ tone: "error", title: "Invalid OTP", body: "OTP must be exactly 6 digits." });
      return;
    }

    setBusy(true);
    try {
      await withAbdmSession(environment, () =>
        verifyAbhaContactUpdate({ patientId, transactionId, otp: clean, type, environment }),
      );
      setDone(true);
      onDone(cleanValue);
    } catch (err) {
      setError(mapApiError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="notice" style={{ marginTop: 10 }}>
        <span className="dot ok" />
        The {label} on the ABHA was updated.
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 14, marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Update the {label} on the ABHA</div>
      {intro && <p className="osh-sub" style={{ margin: "0 0 8px" }}>{intro}</p>}
      {error && (
        <div style={{ marginBottom: 10 }}>
          <StopState {...error} />
        </div>
      )}

      {!transactionId ? (
        <>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>New {label}</label>
            {type === "mobile" ? (
              <div className="mobile-wrap">
                <span className="mobile-prefix">+91</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  placeholder="10 digits"
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  disabled={busy}
                />
              </div>
            ) : (
              <input
                className="input"
                type="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={busy}
              />
            )}
            <div className="hint">An OTP is sent to the new {label} to confirm it.</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" type="button" onClick={() => sendOtp()} disabled={busy}>
              {busy ? "Sending..." : "Send OTP"}
            </button>
            <button className="btn-link" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {otpMessage && <p className="osh-sub" style={{ margin: "0 0 8px" }}>{otpMessage}</p>}
          <div className="field" style={{ maxWidth: 220 }}>
            <label>OTP</label>
            <input
              className="input otp-input"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              disabled={busy}
            />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn btn-primary" type="button" onClick={confirm} disabled={busy}>
              {busy ? "Verifying..." : "Verify and update"}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => sendOtp(true)}
              disabled={busy || resendIn > 0 || resendCount >= MAX_OTP_RESENDS}
            >
              {resendCount >= MAX_OTP_RESENDS
                ? "Resend limit reached"
                : resendIn > 0
                  ? `Resend OTP in ${resendIn}s`
                  : `Resend OTP (${MAX_OTP_RESENDS - resendCount} left)`}
            </button>
            <button className="btn-link" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

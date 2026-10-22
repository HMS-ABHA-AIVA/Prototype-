import { useEffect, useState } from "react";
import {
  createAbhaAddress,
  getAbhaAddressSuggestions,
  requestEnrolMobileOtp,
  verifyEnrolMobileOtp,
  type AbdmEnvironment,
} from "@/api/endpoints";
import { withAbdmSession } from "@/api/abdmSession";
import { StopState } from "@/pages/ErrorStates";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";

import { ABHA_ADDRESS_POLICY, MAX_OTP_RESENDS, OTP_RESEND_SECONDS, isValidAbhaAddressName } from "@/lib/abhaRules";

/**
 * Shown right after an ABHA is created:
 *  1. mobile verification, when the mobile is not the Aadhaar-linked one
 *  2. ABHA address: typed by staff, or generated from ABDM's suggestions when left empty
 */
export function CreateFollowUps({
  transactionId,
  mobile,
  mobileVerified,
  abhaNumber,
  abhaAddress,
  environment,
  onDone,
}: {
  transactionId: string;
  mobile: string;
  mobileVerified: boolean;
  abhaNumber: string;
  abhaAddress: string | null;
  environment: AbdmEnvironment;
  /** Called with the ABHA address as it stands when the user continues. */
  onDone: (abhaAddress: string | null) => void;
}) {
  const [verified, setVerified] = useState(mobileVerified);
  const [otpSent, setOtpSent] = useState(false);
  const [otpMessage, setOtpMessage] = useState("");
  const [otp, setOtp] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [resendCount, setResendCount] = useState(0);

  const [address, setAddress] = useState(abhaAddress);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [custom, setCustom] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MappedErrorState | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // ABDM's suggested addresses, offered as quick picks and used when the box is left empty
  useEffect(() => {
    let cancelled = false;
    withAbdmSession(environment, () => getAbhaAddressSuggestions(transactionId, environment))
      .then((res) => {
        if (!cancelled) setSuggestions(res.data.suggestions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [transactionId, environment]);

  async function run(task: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(mapApiError(err, { label: "Try again", onClick: () => setError(null) }));
    } finally {
      setBusy(false);
    }
  }

  const sendMobileOtp = (isResend = false) => {
    if (isResend && resendCount >= MAX_OTP_RESENDS) return Promise.resolve();
    return run(async () => {
      const res = await withAbdmSession(environment, () => requestEnrolMobileOtp({ transactionId, mobile, environment }));
      setOtpMessage(res.message);
      setOtpSent(true);
      setOtp("");
      setResendCount(isResend ? resendCount + 1 : 0);
      setResendIn(OTP_RESEND_SECONDS);
    });
  };

  const confirmMobileOtp = () => {
    const clean = otp.replace(/\D/g, "");
    if (clean.length !== 6) {
      setError({ tone: "error", title: "Invalid OTP", body: `The OTP has ${clean.length} digit${clean.length === 1 ? "" : "s"}, but it needs 6.` });
      return Promise.resolve();
    }
    return run(async () => {
      await withAbdmSession(environment, () => verifyEnrolMobileOtp({ transactionId, otp: clean, environment }));
      setVerified(true);
      setOtpSent(false);
    });
  };

  const customName = custom.trim().toLowerCase();
  const customError = customName && !isValidAbhaAddressName(customName) ? "Does not follow the ABHA address rules" : "";

  // Typed address wins; with the box empty and no address yet, the first suggestion is used.
  const finish = () =>
    run(async () => {
      const wanted = customName || (address ? "" : suggestions[0] ?? "");
      if (wanted) {
        const res = await withAbdmSession(environment, () => createAbhaAddress({ transactionId, abhaAddress: wanted, environment }));
        setAddress(res.data.abhaAddress);
        onDone(res.data.abhaAddress);
        return;
      }
      onDone(address);
    });

  return (
    <div className="card-form">
      <h2>ABHA created</h2>
      <div className="kv" style={{ marginBottom: 16 }}>
        <div className="k">ABHA number</div>
        <div className="mono">{abhaNumber}</div>
        <div className="k">ABHA address</div>
        <div className="mono">{address ?? "—"}</div>
      </div>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <StopState {...error} />
        </div>
      )}

      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Mobile verification</div>
      {verified ? (
        <p className="osh-sub" style={{ margin: "0 0 16px" }}>
          <span className="dot ok" />
          +91 {mobile} verified
        </p>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <p className="osh-sub" style={{ margin: "0 0 8px" }}>+91 {mobile} not verified</p>
          {!otpSent ? (
            <button className="btn btn-ghost" type="button" onClick={() => sendMobileOtp()} disabled={busy}>
              {busy ? "Sending..." : "Send OTP"}
            </button>
          ) : (
            <>
              {otpMessage && <p className="osh-sub" style={{ margin: "0 0 8px" }}>{otpMessage}</p>}
              <div className="field" style={{ maxWidth: 220 }}>
                <label>OTP</label>
                <input
                  className="input otp-input"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  disabled={busy}
                />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn btn-primary" type="button" onClick={confirmMobileOtp} disabled={busy}>
                  {busy ? "Verifying..." : "Verify"}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => sendMobileOtp(true)}
                  disabled={busy || resendIn > 0 || resendCount >= MAX_OTP_RESENDS}
                >
                  {resendCount >= MAX_OTP_RESENDS
                    ? "Resend limit reached"
                    : resendIn > 0
                      ? `Resend OTP in ${resendIn}s`
                      : `Resend OTP (${MAX_OTP_RESENDS - resendCount} left)`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="field" style={{ maxWidth: 360 }}>
        <label>
          Custom ABHA address <span className="opt">(optional, auto-generated if empty)</span>
        </label>
        <input
          className="input mono"
          autoComplete="off"
          autoCapitalize="none"
          placeholder="ramesh.gupta"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={busy}
        />
        {customError && <div className="hint" style={{ color: "var(--error)" }}>{customError}</div>}
        {suggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {suggestions.slice(0, 6).map((s) => (
              <button key={s} className="btn btn-ghost" type="button" onClick={() => setCustom(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {ABHA_ADDRESS_POLICY.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>

      <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 24 }}>
        <button className="btn btn-primary" type="button" onClick={finish} disabled={busy || Boolean(customError)}>
          {busy ? "Saving..." : "Continue"}
        </button>
      </div>
    </div>
  );
}

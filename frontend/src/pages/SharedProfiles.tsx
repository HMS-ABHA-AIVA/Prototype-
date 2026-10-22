import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { Clock, Printer, QrCode, RefreshCw } from "lucide-react";
import { AppShell, useFacilityName } from "../components/AppShell";
import {
  dismissSharedProfile,
  getShareConfig,
  listSharedProfiles,
  registerSharedProfile,
  type SharedProfile,
} from "@/api/endpoints";
import { ApiError } from "@/api/client";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { mobileProblem } from "@/lib/mobile";
import { useAuthStore } from "@/store/useAuthStore";
import { Alert, Card, EmptyState, PageHeader, StatusBadge, TableSkeleton, useConfirm } from "@/components/ui/kit";

const POLL_MS = 10_000;

function formatDob(s: SharedProfile): string {
  const { dayOfBirth: d, monthOfBirth: m, yearOfBirth: y } = s;
  if (d && m) return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
  return String(y);
}

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(Math.floor((new Date(expiresAt).getTime() - now) / 1000), 0);
}

const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export function SharedProfiles() {
  const navigate = useNavigate();
  const { environment } = useAuthStore();
  const facilityName = useFacilityName();
  const [confirm, confirmDialog] = useConfirm();

  const [shares, setShares] = useState<SharedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MappedErrorState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  // a share that needs a mobile number from staff before it can be registered
  const [needsPhone, setNeedsPhone] = useState<{ id: string; message: string } | null>(null);
  const [phone, setPhone] = useState("");

  const [config, setConfig] = useState<{ hipId: string; qrBaseUrl: string } | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [counter, setCounter] = useState("OPD1");

  const load = useCallback(async () => {
    try {
      const res = await listSharedProfiles();
      setShares(Array.isArray(res.data) ? res.data : []);
      setError(null);
    } catch (err) {
      setError(mapApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useEffect(() => {
    getShareConfig(environment)
      .then((res) => {
        setConfig(res.data);
        setConfigFailed(false);
      })
      .catch(() => {
        setConfig(null);
        setConfigFailed(true);
      });
  }, [environment]);

  async function register(share: SharedProfile, phoneOverride?: string) {
    setBusyId(share.id);
    setError(null);
    try {
      const res = await registerSharedProfile(share.id, phoneOverride ? { phone: phoneOverride } : {});
      navigate(`/record/${res.data.patientId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PHONE_REQUIRED") {
        setNeedsPhone({ id: share.id, message: err.message });
        setPhone("");
      } else {
        setError(mapApiError(err));
        void load();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(share: SharedProfile) {
    const ok = await confirm({
      title: "Dismiss shared profile?",
      body: `${share.name} (token #${share.tokenNumber}) will be removed from the queue. The patient will need to scan the counter QR again.`,
      confirmLabel: "Dismiss",
      danger: true,
    });
    if (!ok) return;
    setBusyId(share.id);
    try {
      await dismissSharedProfile(share.id);
      setShares((list) => list.filter((s) => s.id !== share.id));
    } catch (err) {
      setError(mapApiError(err));
    } finally {
      setBusyId(null);
    }
  }

  const counterOk = /^[A-Za-z0-9]{1,20}$/.test(counter);
  const qrUrl =
    config && counterOk
      ? `${config.qrBaseUrl}?hip-id=${encodeURIComponent(config.hipId)}&counter-id=${encodeURIComponent(counter)}`
      : null;
  const live = shares.filter((s) => new Date(s.expiresAt).getTime() > now);
  const phoneIssue = phone ? mobileProblem(phone) : null;

  return (
    <AppShell active="shared">
      <style>{`@media print { body * { visibility: hidden; } .qr-print, .qr-print * { visibility: visible; } .qr-print { position: absolute; left: 0; top: 0; padding: 24px; } }`}</style>
      {confirmDialog}

      <PageHeader
        title="Scan & Share queue"
        subtitle="Profiles shared by patients who scanned a counter QR code · each token is valid for 30 minutes · refreshes every 10 seconds"
        actions={
          <button className="btn btn-ghost" onClick={() => void load()}>
            <RefreshCw size={15} aria-hidden />
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="error" title={error.title}>
            {error.body}
          </Alert>
        </div>
      )}

      <div className="grid-main-side">
        <Card title="Waiting" icon={Clock} subtitle={loading ? undefined : `${live.length} ${live.length === 1 ? "profile" : "profiles"} with a valid token`} bodyClass="">
          {loading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : live.length === 0 ? (
            <EmptyState icon={QrCode} title="No one waiting" text="Shared profiles appear here a few seconds after a patient scans a counter QR code." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Patient</th>
                    <th>ABHA</th>
                    <th>Mobile</th>
                    <th>Expires in</th>
                    <th className="right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((s) => {
                    const left = secondsLeft(s.expiresAt, now);
                    return (
                      <tr key={s.id}>
                        <td>
                          <div style={{ fontSize: 16, fontWeight: 700 }} className="num">
                            #{s.tokenNumber}
                          </div>
                          <div className="cell-mrn">{s.counterCode}</div>
                        </td>
                        <td className="cell-name">
                          <span className="link-strong">{s.name}</span>
                          <div className="cell-mrn">
                            {s.gender ?? "—"} · born {formatDob(s)}
                          </div>
                          {s.matchedPatient && (
                            <div style={{ marginTop: 4 }}>
                              <StatusBadge tone="info">Already registered</StatusBadge>
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="mono">{s.abhaNumber ?? <span className="faint">Number not shared</span>}</div>
                          <div className="cell-mrn">{s.abhaAddress}</div>
                        </td>
                        <td className="mono">{s.phone ?? <span className="faint">—</span>}</td>
                        <td>
                          <StatusBadge tone={left < 300 ? "warning" : "neutral"} plain>
                            <span className="num">{mmss(left)}</span>
                          </StatusBadge>
                        </td>
                        <td className="actions">
                          {needsPhone?.id === s.id ? (
                            <form
                              style={{ maxWidth: 260, marginLeft: "auto", textAlign: "left", whiteSpace: "normal" }}
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (!phoneIssue && phone) void register(s, phone);
                              }}
                            >
                              <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 6 }}>{needsPhone.message}</div>
                              <input
                                className="input"
                                inputMode="numeric"
                                maxLength={10}
                                aria-label="Mobile number"
                                placeholder="10-digit mobile"
                                value={phone}
                                aria-invalid={Boolean(phoneIssue)}
                                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                              />
                              {phoneIssue && phone.length === 10 && <div className="field-error">{phoneIssue}</div>}
                              <div className="inline mt-2">
                                <button className="btn btn-primary btn-sm" type="submit" disabled={!phone || Boolean(phoneIssue) || busyId === s.id}>
                                  Register
                                </button>
                                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNeedsPhone(null)}>
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <span className="inline" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                              <button className="btn btn-primary btn-sm" disabled={busyId === s.id} onClick={() => void register(s)}>
                                {busyId === s.id && <span className="spinner" aria-hidden />}
                                {s.matchedPatient ? "Open record" : "Register"}
                              </button>
                              <button className="btn btn-ghost btn-sm" disabled={busyId === s.id} onClick={() => void dismiss(s)}>
                                Dismiss
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Counter QR code" icon={QrCode} subtitle="One code per counter · the counter ID becomes the token queue">
          <div className="field">
            <label htmlFor="counter">Counter ID</label>
            <input
              id="counter"
              className="input mono"
              maxLength={20}
              value={counter}
              aria-invalid={!counterOk}
              onChange={(e) => setCounter(e.target.value.trim())}
            />
            {counterOk ? <div className="hint">Letters and digits, e.g. OPD1 or LAB2</div> : <div className="field-error">1 to 20 letters or digits, no spaces</div>}
          </div>
          <div className="qr-print" style={{ textAlign: "center", padding: "8px 0 4px" }}>
            {qrUrl ? (
              <>
                <QRCodeSVG value={qrUrl} size={188} marginSize={2} />
                {facilityName && <div style={{ marginTop: 6, fontWeight: 600 }}>{facilityName}</div>}
                <div className="cell-mrn">Counter {counter} · scan with the ABHA / PHR app to share your profile</div>
              </>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>
                {configFailed ? "The QR code could not be prepared. Check the connection to the hospital server." : counterOk ? "Preparing QR code" : "Enter a valid counter ID"}
              </p>
            )}
          </div>
          <button className="btn btn-ghost btn-block mt-3" disabled={!qrUrl} onClick={() => window.print()}>
            <Printer size={15} aria-hidden />
            Print counter QR
          </button>
        </Card>
      </div>
    </AppShell>
  );
}

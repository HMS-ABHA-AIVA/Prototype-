import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ChevronLeft, Download, History, IdCard, Printer, QrCode, RefreshCw, UserPlus, UserRoundX } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { useAuthStore } from "@/store/useAuthStore";
import { ApiError } from "@/api/client";
import {
  listPatients,
  listPatientTransactions,
  getAbhaProfile,
  getAbhaQrCodeBlob,
  getAbhaCardBlob,
  type BackendPatientWithAbha,
  type AbhaTransaction,
  type FullAbhaProfile,
} from "@/api/endpoints";
import { withAbdmSession } from "@/api/abdmSession";
import { AbhaProfileCard, HospitalRecordCard, genderLabel, photoSrc } from "@/components/AbhaProfileDetails";
import { AbhaCard } from "@/components/AbhaCard";
import { useFacilityName } from "@/components/AppShell";
import { Alert, Card, EmptyState, Skeleton, StatusBadge, type BadgeTone } from "@/components/ui/kit";
import { PatientHandOff } from "@/hospital/modules/registration/PatientHandOff";

function formatDateTime(dateStr?: string) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime())
    ? dateStr
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTimeOnly(dateStr?: string) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ageFromDob(dob: string): number {
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

const TXN_TONE: Record<string, BadgeTone> = { COMPLETED: "success", FAILED: "danger", EXPIRED: "neutral", PENDING: "warning" };

export function PatientRecord() {
  const { patientId } = useParams<{ patientId: string }>();
  const navigate = useNavigate();
  // set by the register page, e.g. when the ABHA entered already belonged to this patient
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const { environment } = useAuthStore();
  const facility = useFacilityName();

  const [patient, setPatient] = useState<BackendPatientWithAbha | null>(null);
  const [transactions, setTransactions] = useState<AbhaTransaction[]>([]);
  const [liveProfile, setLiveProfile] = useState<FullAbhaProfile | null>(null);
  const [qrUrl, setQrUrl] = useState<string>("");
  const [liveNote, setLiveNote] = useState<string>("");
  const [qrNote, setQrNote] = useState<string>("");
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // bumped after the ABHA's mobile/email changed so the live profile is read again
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let createdUrl = "";

    async function loadData() {
      if (!patientId) return;
      setLoading(true);
      setLoadError(false);
      setLiveNote("");
      setQrNote("");

      try {
        let currentPatient: BackendPatientWithAbha | null = null;
        let txns: AbhaTransaction[] = [];

        try {
          const [patientsRes, txnsRes] = await Promise.all([
            listPatients(),
            listPatientTransactions(patientId).catch(() => ({ data: [] })),
          ]);
          currentPatient = (patientsRes.data || []).find((p) => p.id === patientId) || null;
          txns = Array.isArray(txnsRes.data) ? txnsRes.data : [];
        } catch (err) {
          console.error("Error loading patient:", err);
          if (active) setLoadError(true);
        }

        if (!active) return;
        setPatient(currentPatient);
        setTransactions(txns);

        // If an ABHA is linked, try fetching the live profile and QR code
        if (currentPatient?.abha) {
          // Live details and QR need this ABHA to have been verified in the current session; the stored
          // ABHA number is still shown without them. Say why when either is missing instead of hiding it.
          const reason = (err: unknown) => (err instanceof ApiError ? err.message : "Could not reach the server.");

          await Promise.all([
            withAbdmSession(environment, () => getAbhaProfile(patientId, environment)).then(
              (profileRes) => {
                if (active && profileRes.data) setLiveProfile(profileRes.data);
              },
              (err) => {
                if (active) setLiveNote(`Live ABHA details unavailable: ${reason(err)}`);
              },
            ),
            withAbdmSession(environment, () => getAbhaQrCodeBlob(patientId, environment)).then(
              (blob) => {
                if (!active) return;
                createdUrl = URL.createObjectURL(blob);
                setQrUrl(createdUrl);
              },
              (err) => {
                if (active) setQrNote(`QR unavailable: ${reason(err)}`);
              },
            ),
          ]);
        }
      } catch (err) {
        console.error("Error loading patient record:", err);
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadData();

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [patientId, environment, reloadKey]);

  // Downloads the official ABHA card from ABDM (needs the ABHA to be verified in this session, like the QR).
  async function handleDownloadCard() {
    if (!patientId) return;
    setCardError("");
    setCardBusy(true);
    try {
      const blob = await withAbdmSession(environment, () => getAbhaCardBlob(patientId, environment));
      const ext = blob.type.includes("pdf") ? "pdf" : blob.type.includes("jpeg") ? "jpg" : "png";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${patient?.name || "Patient"}_ABHA_card.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setCardError(`ABHA card unavailable: ${err instanceof ApiError ? err.message : "Could not reach the server."}`);
    } finally {
      setCardBusy(false);
    }
  }

  function handleSaveQr() {
    if (!qrUrl) return;
    const a = document.createElement("a");
    a.href = qrUrl;
    a.download = `${patient?.name || "Patient"}_ABHA_QR.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  const back = (
    <button type="button" className="back-link" onClick={() => navigate("/registration")}>
      <ChevronLeft size={14} aria-hidden />
      Patient register
    </button>
  );

  if (loading && !patient) {
    return (
      <AppShell active="registration">
        {back}
        <div className="patient-banner" aria-busy="true">
          <div className="patient-id">
            <span className="patient-avatar" />
            <div style={{ display: "grid", gap: 8 }}>
              <Skeleton width={220} height={18} />
              <Skeleton width={320} />
            </div>
          </div>
        </div>
        <div className="grid-main-side">
          <div className="card card-body">
            <Skeleton />
            <div className="mt-3">
              <Skeleton width="70%" />
            </div>
          </div>
          <div className="card card-body">
            <Skeleton />
          </div>
        </div>
      </AppShell>
    );
  }

  if (!patient) {
    return (
      <AppShell active="registration">
        {back}
        <div className="card">
          {loadError ? (
            <div className="card-body">
              <Alert
                tone="error"
                title="The patient record could not be loaded"
                actions={
                  <button className="btn btn-sm btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
                    Try again
                  </button>
                }
              >
                Check the connection to the hospital server.
              </Alert>
            </div>
          ) : (
            <EmptyState icon={UserRoundX} title="Patient not found" text="No patient with this ID is registered at this hospital." />
          )}
        </div>
      </AppShell>
    );
  }

  const isLinked = Boolean(patient.abha);
  const abhaNumber = patient.abha?.abhaNumber || liveProfile?.ABHANumber || "—";
  const abhaAddress = patient.abha?.abhaAddress || liveProfile?.preferredAbhaAddress || "—";
  const initials = patient.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  const gender = genderLabel(patient.gender);

  return (
    <AppShell active="registration" crumb={patient.name}>
      {back}

      <div className="patient-banner">
        <div className="patient-id">
          <span className="patient-avatar" aria-hidden>
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <h1 className="patient-name">{patient.name}</h1>
            <div className="patient-facts">
              <span>{patient.dateOfBirth ? `${ageFromDob(patient.dateOfBirth)} y` : "Age not recorded"}</span>
              {gender && <span>{gender}</span>}
              <span className="num">DOB {patient.dateOfBirth ?? "—"}</span>
            </div>
          </div>
        </div>
        <div className="patient-meta">
          <div>
            <div className="k">Mobile</div>
            <div className="v mono">{patient.phone ? `+91 ${patient.phone}` : "—"}</div>
          </div>
          <div>
            <div className="k">ABHA</div>
            <div className="v">{isLinked ? <StatusBadge tone="success">Linked</StatusBadge> : <StatusBadge>Not linked</StatusBadge>}</div>
          </div>
          <div>
            <div className="k">Registered</div>
            <div className="v num">{formatDateTime(patient.createdAt)}</div>
          </div>
        </div>
      </div>

      {/* The way into the hospital modules for this patient (clinical chart, OPD billing), for the roles that use them */}
      <div className="inline mb-4">
        <PatientHandOff patientId={patient.id} />
      </div>

      {(notice || patient.abhaUpdateNote) && (
        <div className="stack mb-4" style={{ gap: 8 }}>
          {notice && <Alert tone="info">{notice}</Alert>}
          {patient.abhaUpdateNote && (
            <Alert tone="warning" title="Details updated from ABHA">
              {patient.abhaUpdateNote}
            </Alert>
          )}
        </div>
      )}

      <div className="grid-main-side">
        <div className="stack">
          <Card
            title="ABHA"
            icon={IdCard}
            actions={
              isLinked ? (
                <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/register?patientId=${patient.id}&refresh=1`)}>
                  <RefreshCw size={13} aria-hidden />
                  Verify again
                </button>
              ) : undefined
            }
          >
            {isLinked ? (
              <>
                <AbhaCard
                  data={{
                    name: liveProfile?.name?.trim() || patient.name,
                    abhaNumber,
                    abhaAddress,
                    dateOfBirth: patient.dateOfBirth ?? liveProfile?.dob ?? null,
                    gender: genderLabel(liveProfile?.gender) ?? genderLabel(patient.gender) ?? null,
                    photo: photoSrc(liveProfile?.profilePhoto),
                    qrUrl,
                    facilityName: facility,
                  }}
                />

                {(liveNote || qrNote || cardError) && (
                  <div className="mt-3">
                    <Alert
                      tone="warning"
                      title="Live ABHA data not available"
                      actions={
                        <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/register?patientId=${patient.id}&refresh=1`)}>
                          Verify ABHA to load live data
                        </button>
                      }
                    >
                      {[liveNote, qrNote, cardError].filter(Boolean).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </Alert>
                  </div>
                )}

                <div className="inline mt-4">
                  <button className="btn btn-ghost" onClick={() => window.print()}>
                    <Printer size={15} aria-hidden />
                    Print ABHA card
                  </button>
                  <button className="btn btn-ghost" onClick={handleSaveQr} disabled={!qrUrl}>
                    <QrCode size={15} aria-hidden />
                    Save QR image
                  </button>
                  <button className="btn btn-ghost" onClick={handleDownloadCard} disabled={cardBusy}>
                    {cardBusy ? <span className="spinner" aria-hidden /> : <Download size={15} aria-hidden />}
                    {cardBusy ? "Downloading" : "Download ABHA card"}
                  </button>
                </div>
                <p className="abha-note">Live details and the QR code are read from ABDM each time this page opens and are not stored here.</p>
              </>
            ) : (
              <EmptyState
                icon={IdCard}
                title="No ABHA linked"
                text="Link an existing ABHA or create a new one with the patient's consent."
                action={
                  <button className="btn btn-primary" onClick={() => navigate(`/register?patientId=${patient.id}`)}>
                    <UserPlus size={15} aria-hidden />
                    Add ABHA
                  </button>
                }
              />
            )}
          </Card>

          {isLinked && (
            <AbhaProfileCard patient={patient} liveProfile={liveProfile} environment={environment} onAbhaContactUpdated={() => setReloadKey((k) => k + 1)} />
          )}

          <Card title="ABHA transactions" icon={History} subtitle="OTP and linking attempts for this patient, newest first" bodyClass="">
            {transactions.length === 0 ? (
              <EmptyState icon={History} title="No ABHA transactions" text="OTP requests and verifications for this patient appear here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th>OTP valid until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((t) => (
                      <tr key={t.id}>
                        <td>{t.purpose === "ENROLLMENT" ? "Create ABHA" : "Link existing ABHA"}</td>
                        <td>
                          <StatusBadge tone={TXN_TONE[t.status ?? "PENDING"] ?? "neutral"}>
                            {t.status ? t.status.charAt(0) + t.status.slice(1).toLowerCase() : "Pending"}
                          </StatusBadge>
                        </td>
                        <td className="num nowrap">{formatDateTime(t.createdAt)}</td>
                        <td className="num nowrap">{formatTimeOnly(t.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <HospitalRecordCard patient={patient} onPatientUpdated={setPatient} />
        </div>
      </div>
    </AppShell>
  );
}

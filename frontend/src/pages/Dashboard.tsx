import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  BedDouble,
  ChevronRight,
  ClipboardList,
  FlaskConical,
  IdCard,
  Package,
  Pill,
  QrCode,
  Receipt,
  Recycle,
  RefreshCw,
  Siren,
  UserPlus,
  Users,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "../components/AppShell";
import { useAuthStore } from "@/store/useAuthStore";
import { canOpenPath, ROLE_LABELS } from "@/hospital/components/layout/navConfig";
import { useHospitalStore } from "@/hospital/store/useHospitalStore";
import { useRefresh } from "@/hospital/store/useRefresh";
import type { DashboardSummary } from "@/hospital/api/clinical";
import type { StaffRole } from "@/api/endpoints";
import { getDashboard, type DashboardData } from "@/api/endpoints";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { Alert, Card, EmptyState, PageHeader, Skeleton, StatusBadge, TableSkeleton } from "@/components/ui/kit";

const REFRESH_MS = 30_000;


// Audit action codes -> staff-readable text
const ACTION_LABELS: Record<string, string> = {
  CREATE_AADHAAR_OTP_REQUEST: "ABHA creation: Aadhaar OTP requested",
  CREATE_AADHAAR_OTP_VERIFY: "ABHA creation: Aadhaar OTP verified",
  CREATE_MOBILE_OTP_REQUEST: "ABHA creation: mobile OTP requested",
  CREATE_MOBILE_OTP_VERIFY: "ABHA creation: mobile OTP verified",
  ABHA_ADDRESS_SUGGESTIONS: "ABHA address suggestions viewed",
  ABHA_ADDRESS_CREATE: "ABHA address created",
  LINK_AADHAAR_OTP_REQUEST: "Link by Aadhaar: OTP requested",
  LINK_AADHAAR_OTP_VERIFY: "Link by Aadhaar: OTP verified",
  LINK_MOBILE_OTP_REQUEST: "Link by mobile: OTP requested",
  LINK_MOBILE_OTP_VERIFY: "Link by mobile: OTP verified",
  LINK_MOBILE_SELECT_ACCOUNT: "Link by mobile: ABHA chosen",
  LINK_ABHA_NUMBER_OTP_REQUEST: "Link by ABHA number: OTP requested",
  LINK_ABHA_NUMBER_OTP_VERIFY: "Link by ABHA number: OTP verified",
  LINK_ABHA_ADDRESS_OTP_REQUEST: "Link by ABHA address: OTP requested",
  LINK_ABHA_ADDRESS_OTP_VERIFY: "Link by ABHA address: OTP verified",
  ABHA_PROFILE_VIEW: "ABHA profile viewed",
  ABHA_QR_VIEW: "ABHA QR viewed",
  ABHA_CARD_DOWNLOAD: "ABHA card downloaded",
  ABHA_CONTACT_UPDATE_OTP_REQUEST: "ABHA contact update: OTP requested",
  ABHA_CONTACT_UPDATE_OTP_VERIFY: "ABHA contact updated",
  SHARE_REGISTER: "Shared profile registered",
  SHARE_DISMISS: "Shared profile dismissed",
  ABDM_SESSION: "ABDM session started",
};

const labelFor = (action: string) => ACTION_LABELS[action] ?? action.toLowerCase().replace(/_/g, " ");

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** The roles that register patients and work with ABHA (the M1 screens). */
const M1_ROLES: StaffRole[] = ["front_office", "doctor", "nurse", "biller", "admin"];

export function Dashboard() {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const staff = session?.kind === "staff" ? session : null;
  const role: StaffRole = staff?.role ?? "front_office";
  const showAbha = M1_ROLES.includes(role);

  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<MappedErrorState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!showAbha) return;
    let cancelled = false;
    const load = async () => {
      setRefreshing(true);
      try {
        const dash = await getDashboard();
        if (cancelled) return;
        setData(dash.data);
        setError(null);
        setUpdatedAt(new Date());
      } catch (err) {
        if (!cancelled) setError(mapApiError(err));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tick, showAbha]);

  const linkedPct = data && data.totalPatients > 0 ? Math.round((data.abhaLinked / data.totalPatients) * 100) : 0;

  return (
    <AppShell active="dashboard">
      <PageHeader
        title={staff ? `Welcome, ${staff.name}` : "Dashboard"}
        subtitle={[staff && ROLE_LABELS[staff.role], staff?.department, "live counts for this hospital"].filter(Boolean).join(" · ")}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setTick((t) => t + 1)} disabled={refreshing} aria-label="Refresh counts">
              <RefreshCw size={15} aria-hidden className={refreshing ? "spin" : undefined} />
              Refresh
            </button>
            {showAbha && (
              <button className="btn btn-primary" onClick={() => navigate("/register")}>
                <UserPlus size={16} aria-hidden />
                New registration
              </button>
            )}
          </>
        }
      />

      <HospitalCounts role={role} tick={tick} />

      {showAbha && (
      <>
      <h2 className="section-title">ABHA and registration{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}</h2>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alert
            tone="error"
            title={error.title}
            actions={
              <button className="btn btn-sm btn-ghost" onClick={() => setTick((t) => t + 1)}>
                Try again
              </button>
            }
          >
            {error.body}
          </Alert>
        </div>
      )}

      <div className="metrics" style={{ marginBottom: 16 }}>
        {!data ? (
          Array.from({ length: 4 }, (_, i) => (
            <div className="metric" key={i} aria-busy="true">
              <Skeleton width="55%" />
              <Skeleton width="30%" height={26} />
              <Skeleton width="45%" />
            </div>
          ))
        ) : (
          <>
            <button type="button" className="metric" onClick={() => navigate("/registration")}>
              <span className="metric-label">
                <Users size={15} aria-hidden />
                Registered patients
              </span>
              <span className="metric-value">{data.totalPatients}</span>
              <span className="metric-note">{data.registeredToday} registered today</span>
            </button>
            <div className="metric">
              <span className="metric-label">
                <IdCard size={15} aria-hidden />
                ABHA linked
              </span>
              <span className="metric-value">{data.abhaLinked}</span>
              <span className="metric-note">{linkedPct}% of registered patients</span>
              <div className="progress" aria-label={`${linkedPct}% of patients have an ABHA`}>
                <span style={{ width: `${linkedPct}%` }} />
              </div>
            </div>
            <button type="button" className="metric" onClick={() => navigate("/registration")}>
              <span className="metric-label">
                <UserX size={15} aria-hidden />
                Without ABHA
              </span>
              <span className="metric-value">{data.withoutAbha}</span>
              <span className="metric-note">ABHA can be added from the patient record</span>
            </button>
            <button type="button" className="metric" onClick={() => navigate("/shared-profiles")}>
              <span className="metric-label">
                <QrCode size={15} aria-hidden />
                Scan &amp; Share waiting
              </span>
              <span className="metric-value">{data.pendingShares}</span>
              <span className="metric-note">Profiles shared at the counter, not yet registered</span>
            </button>
          </>
        )}
      </div>

      <div className="grid-main-side">
        <Card
          title="Recent ABHA activity"
          icon={Activity}
          subtitle="Latest ABDM operations at this hospital"
          bodyClass=""
        >
          {!data ? (
            <TableSkeleton rows={5} cols={3} />
          ) : data.recentActivity.length === 0 ? (
            <EmptyState icon={Activity} title="No ABHA activity yet" text="ABHA creation, linking and Scan & Share events appear here." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 140 }}>Time</th>
                    <th>Event</th>
                    <th style={{ width: 160 }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.map((a) => (
                    <tr key={a.id}>
                      <td className="mono nowrap">{fmtDateTime(a.createdAt)}</td>
                      <td>{labelFor(a.action)}</td>
                      <td>
                        {a.outcome === "SUCCESS" ? (
                          <StatusBadge tone="success">Completed</StatusBadge>
                        ) : (
                          <StatusBadge tone="danger">{a.errorCode ? `Failed · ${a.errorCode}` : "Failed"}</StatusBadge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title="Needs attention" icon={UserX} bodyClass="">
            {!data ? (
              <div className="card-body">
                <Skeleton />
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                <AttentionRow
                  label="Shared profiles awaiting registration"
                  count={data.pendingShares}
                  onClick={() => navigate("/shared-profiles")}
                />
                <AttentionRow label="Patients without an ABHA" count={data.withoutAbha} onClick={() => navigate("/registration")} />
              </ul>
            )}
          </Card>
        </div>
      </div>
      </>
      )}
    </AppShell>
  );
}

interface Tile {
  key: string;
  label: string;
  icon: LucideIcon;
  path: string;
  value: (d: DashboardSummary) => string | number;
  note: (d: DashboardSummary) => string;
  alert?: (d: DashboardSummary) => boolean;
}

// The hospital's working counts; each tile opens its screen, and a role sees the tiles for the screens it works with.
const TILES: Tile[] = [
  { key: "opd", label: "OPD waiting", icon: ClipboardList, path: "/opd", value: (d) => d.opdWaiting,
    note: (d) => (d.opdAwaitingPayment > 0 ? `${d.opdAwaitingPayment} more awaiting OPD billing` : "tokens across all departments") },
  { key: "er", label: "In emergency", icon: Siren, path: "/emergency", value: (d) => d.erActive,
    note: (d) => (d.erRedTriage > 0 ? `${d.erRedTriage} red-triage` : "active cases"), alert: (d) => d.erRedTriage > 0 },
  { key: "beds", label: "Bed occupancy", icon: BedDouble, path: "/ipd", value: (d) => `${d.occupancyPct}%`,
    note: (d) => `${d.bedsOccupied} of ${d.bedsTotal} beds occupied` },
  { key: "lab", label: "Lab & radiology", icon: FlaskConical, path: "/lab", value: (d) => d.labPending,
    note: (d) => (d.criticalResults > 0 ? `${d.criticalResults} critical result(s) to acknowledge` : "tests not yet reported"), alert: (d) => d.criticalResults > 0 },
  { key: "bills", label: "Draft bills", icon: Receipt, path: "/billing", value: (d) => d.draftBills, note: () => "awaiting finalisation" },
  { key: "drugs", label: "Medicines low", icon: Pill, path: "/pharmacy", value: (d) => d.lowStockDrugs, note: () => "at or below reorder level",
    alert: (d) => d.lowStockDrugs > 0 },
  { key: "supplies", label: "Supplies low", icon: Package, path: "/supplies", value: (d) => d.lowStockSupplies, note: () => "at or below reorder level",
    alert: (d) => d.lowStockSupplies > 0 },
  { key: "waste", label: "Waste to dispose", icon: Recycle, path: "/housekeeping/waste", value: (d) => d.wasteAwaitingDisposal,
    note: () => "bio-medical waste batches not yet handed over" },
];

function HospitalCounts({ role, tick }: { role: StaffRole; tick: number }) {
  const navigate = useNavigate();
  const dashboard = useHospitalStore((s) => s.dashboard);
  const loadDashboard = useHospitalStore((s) => s.loadDashboard);
  useRefresh(["dashboard"], 30);
  useEffect(() => {
    if (tick > 0) void loadDashboard();
  }, [tick, loadDashboard]);

  const tiles = TILES.filter((t) => canOpenPath(role, t.path));
  if (tiles.length === 0) return null;
  return (
    <div className="metrics" style={{ marginBottom: 20 }}>
      {tiles.map((t) => {
        const Icon = t.icon;
        if (!dashboard) {
          return (
            <div className="metric" key={t.key} aria-busy="true">
              <Skeleton width="55%" />
              <Skeleton width="30%" height={26} />
              <Skeleton width="45%" />
            </div>
          );
        }
        const alert = t.alert?.(dashboard) ?? false;
        return (
          <button type="button" className={`metric${alert ? " metric-alert" : ""}`} key={t.key} onClick={() => navigate(t.path)}>
            <span className="metric-label">
              <Icon size={15} aria-hidden />
              {t.label}
            </span>
            <span className="metric-value">{t.value(dashboard)}</span>
            <span className="metric-note">{t.note(dashboard)}</span>
          </button>
        );
      })}
    </div>
  );
}

function AttentionRow({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <li style={{ borderTop: "1px solid var(--border)" }} className="attention-row">
      <button
        type="button"
        onClick={onClick}
        className="between"
        style={{ width: "100%", padding: "11px 16px", background: "none", border: "none", cursor: "pointer", fontSize: 13.5, color: "var(--text)", textAlign: "left" }}
      >
        <span>{label}</span>
        <span className="inline" style={{ gap: 6 }}>
          <StatusBadge tone={count > 0 ? "warning" : "neutral"} plain>
            {count}
          </StatusBadge>
          <ChevronRight size={14} aria-hidden style={{ color: "var(--text-3)" }} />
        </span>
      </button>
    </li>
  );
}

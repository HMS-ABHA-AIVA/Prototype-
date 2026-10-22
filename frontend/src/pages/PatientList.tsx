import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search, Trash2, UserPlus, Users } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { deletePatient, listPatients, type BackendPatientWithAbha } from "@/api/endpoints";
import { useAuthStore } from "@/store/useAuthStore";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { Alert, EmptyState, PageHeader, StatusBadge, TableSkeleton, useConfirm } from "@/components/ui/kit";

export interface PatientRow {
  id: string;
  name: string;

  age?: number | undefined;
  sex?: string | undefined;
  mobile: string;
  abhaNum?: string | undefined;
  abhaAddress?: string | null | undefined;
  createdAt: string;
  raw: BackendPatientWithAbha;
}

type AbhaFilter = "all" | "linked" | "not";
const PAGE_SIZE = 25;
const GENDER: Record<string, string> = { M: "Male", F: "Female", O: "Other" };

function ageFromDob(dob: string): number {
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export function PatientList() {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const [q, setQ] = useState("");
  const [abhaFilter, setAbhaFilter] = useState<AbhaFilter>("all");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [reload, setReload] = useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<MappedErrorState | null>(null);
  // Sessions saved before roles existed belonged to administrators. The server enforces the same rule.
  const isAdmin = session?.kind === "staff";

  useEffect(() => {
    let cancelled = false;
    async function fetchPatients() {
      setLoading(true);
      setError(null);
      try {
        const res = await listPatients();
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setPatients(
          list.map((p) => ({
            id: p.id,
            name: p.name,

            age: p.dateOfBirth ? ageFromDob(p.dateOfBirth) : undefined,
            sex: p.gender ? GENDER[p.gender] ?? p.gender : undefined,
            mobile: p.phone,
            abhaNum: p.abha?.abhaNumber,
            abhaAddress: p.abha?.abhaAddress,
            createdAt: p.createdAt,
            raw: p,
          })),
        );
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load patients from the server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchPatients();
    return () => {
      cancelled = true;
    };
  }, [session, reload]);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const queryDigits = query.replace(/\D/g, "");
    return patients.filter((r) => {
      if (abhaFilter === "linked" && !r.abhaNum) return false;
      if (abhaFilter === "not" && r.abhaNum) return false;
      if (!query) return true;
      const haystack = [r.name, r.mobile, r.abhaNum ?? "", r.abhaAddress ?? ""].join(" ").toLowerCase();
      if (haystack.includes(query)) return true;
      if (queryDigits.length > 0) {
        if ((r.abhaNum ?? "").replace(/\D/g, "").includes(queryDigits)) return true;
        if ((r.mobile ?? "").replace(/\D/g, "").includes(queryDigits)) return true;
      }
      return false;
    });
  }, [patients, q, abhaFilter]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const linkedCount = patients.filter((p) => p.abhaNum).length;

  async function removePatient(r: PatientRow) {
    const ok = await confirm({
      title: `Delete ${r.name}?`,
      body: `${r.name} will be removed from this hospital together with its ABHA link and OTP history. This cannot be undone. The person's ABHA at ABDM is not affected.`,
      confirmLabel: "Delete patient",
      danger: true,
    });
    if (!ok) return;
    setDeletingId(r.id);
    setDeleteError(null);
    try {
      await deletePatient(r.id);
      setPatients((list) => list.filter((p) => p.id !== r.id));
    } catch (err) {
      setDeleteError(mapApiError(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppShell active="registration">
      {confirmDialog}
      {deleteError && (
        <div className="mb-4">
          <Alert tone="error" title={deleteError.title}>
            {deleteError.body}
          </Alert>
        </div>
      )}
      <PageHeader
        title="Patient register"
        subtitle="All patients registered at this hospital, newest first"
        actions={
          <button className="btn btn-primary" onClick={() => navigate("/register")}>
            <UserPlus size={16} aria-hidden />
            New registration
          </button>
        }
      />

      {error ? (
        <Alert
          tone="error"
          title="Patients could not be loaded"
          actions={
            <button className="btn btn-sm btn-ghost" onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
          }
        >
          {error}
        </Alert>
      ) : (
        <section className="card">
          <div className="toolbar">
            <div className="search">
              <Search size={15} aria-hidden />
              <input
                className="input"
                type="search"
                aria-label="Search patients"
                placeholder="Search name, mobile, ABHA number or address"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="seg" role="radiogroup" aria-label="ABHA status">
              {(
                [
                  ["all", `All (${patients.length})`],
                  ["linked", `ABHA linked (${linkedCount})`],
                  ["not", `No ABHA (${patients.length - linkedCount})`],
                ] as const
              ).map(([key, label]) => (
                <button key={key} type="button" role="radio" aria-checked={abhaFilter === key} className={abhaFilter === key ? "on" : ""} onClick={() => {
                    setAbhaFilter(key);
                    setPage(1);
                  }}>
                  {label}
                </button>
              ))}
            </div>
            {!loading && (
              <span className="toolbar-meta">
                {rows.length} {rows.length === 1 ? "patient" : "patients"}
              </span>
            )}
          </div>

          {loading ? (
            <TableSkeleton rows={6} cols={5} />
          ) : patients.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No patients registered yet"
              text="Registered patients appear here with their MRN and ABHA status."
              action={
                <button className="btn btn-primary" onClick={() => navigate("/register")}>
                  <UserPlus size={16} aria-hidden />
                  New registration
                </button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState icon={Search} title="No matching patients" text={q ? `Nothing matches “${q}”.` : "No patients in this view."} />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Patient</th>
                      <th>Age / sex</th>
                      <th>Mobile</th>
                      <th>ABHA</th>
                      <th>Registered</th>
                      <th className="right">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => navigate(`/record/${r.id}`)}>
                        <td className="cell-name">
                          <a
                            href={`/record/${r.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigate(`/record/${r.id}`);
                            }}
                          >
                            {r.name}
                          </a>

                        </td>
                        <td className="nowrap">
                          {r.age !== undefined ? `${r.age} y` : "—"}
                          {r.sex ? <span className="muted"> · {r.sex}</span> : null}
                        </td>
                        <td className="mono">{r.mobile ? `+91 ${r.mobile}` : <span className="faint">—</span>}</td>
                        <td>
                          {r.abhaNum ? (
                            <>
                              <StatusBadge tone="success">Linked</StatusBadge>
                              <div className="cell-mrn">{r.abhaNum}</div>
                            </>
                          ) : (
                            <StatusBadge tone="neutral">Not linked</StatusBadge>
                          )}
                        </td>
                        <td className="nowrap muted">{fmtDate(r.createdAt)}</td>
                        <td className="actions">
                          <span className="inline" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                            {!r.abhaNum && (
                              <button
                                className="btn btn-sm btn-ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/register?patientId=${r.id}`);
                                }}
                              >
                                Add ABHA
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                className="btn btn-sm btn-quiet"
                                aria-label={`Delete ${r.name}`}
                                title="Delete patient"
                                disabled={deletingId === r.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void removePatient(r);
                                }}
                              >
                                <Trash2 size={14} aria-hidden />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="card-foot between">
                  <span>
                    {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}
                  </span>
                  <span className="inline">
                    <button className="btn btn-sm btn-ghost" onClick={() => setPage((p) => p - 1)} disabled={page === 1} aria-label="Previous page">
                      <ChevronLeft size={14} aria-hidden />
                      Previous
                    </button>
                    <span className="num">
                      Page {page} of {pages}
                    </span>
                    <button className="btn btn-sm btn-ghost" onClick={() => setPage((p) => p + 1)} disabled={page === pages} aria-label="Next page">
                      Next
                      <ChevronRight size={14} aria-hidden />
                    </button>
                  </span>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </AppShell>
  );
}

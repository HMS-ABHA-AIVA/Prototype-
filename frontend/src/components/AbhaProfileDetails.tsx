import { useState } from "react";
import { Lock, Mail, Pencil, Phone, ShieldCheck, UserRound } from "lucide-react";
import { updatePatient, type AbdmEnvironment, type BackendPatientWithAbha, type FullAbhaProfile } from "@/api/endpoints";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { mobileProblem } from "@/lib/mobile";
import { StopState } from "@/pages/ErrorStates";
import { ContactUpdate } from "@/components/ContactUpdate";
import { Card, StatusBadge } from "@/components/ui/kit";

const GENDER_LABEL: Record<string, string> = { M: "Male", F: "Female", O: "Other", MALE: "Male", FEMALE: "Female", OTHER: "Other" };
export const genderLabel = (value: unknown) =>
  typeof value === "string" && value ? (GENDER_LABEL[value.trim().toUpperCase()] ?? value) : undefined;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

export const photoSrc = (value: unknown) => {
  const raw = text(value);
  if (!raw) return undefined;
  return raw.startsWith("data:") ? raw : `data:image/jpeg;base64,${raw}`;
};

const Fixed = () => (
  <span title="Fixed once verified against the ABHA" style={{ marginLeft: 6, color: "var(--text-3)", verticalAlign: "-2px" }}>
    <Lock size={12} aria-label="fixed" />
  </span>
);

/**
 * The ABHA profile as ABDM returns it after verification in this session. The mobile / email on the ABHA itself
 * are changed through an OTP (ContactUpdate).
 */
export function AbhaProfileCard({
  patient,
  liveProfile,
  environment,
  onAbhaContactUpdated,
}: {
  patient: BackendPatientWithAbha;
  liveProfile: FullAbhaProfile | null;
  environment: AbdmEnvironment;
  onAbhaContactUpdated: () => void;
}) {
  const [contactEdit, setContactEdit] = useState<"mobile" | "email" | null>(null);
  const photo = photoSrc(liveProfile?.profilePhoto);

  return (
    <Card
      title="ABHA profile"
      icon={ShieldCheck}
      subtitle={liveProfile ? "Read live from ABDM" : "Live profile not loaded in this session"}
      actions={
        liveProfile?.kycVerified === true ? (
          <StatusBadge tone="success">KYC verified</StatusBadge>
        ) : liveProfile?.kycVerified === false ? (
          <StatusBadge tone="warning">KYC not verified</StatusBadge>
        ) : undefined
      }
    >
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {photo && (
          <img
            src={photo}
            alt="Photo on the ABHA"
            width={76}
            height={76}
            style={{ objectFit: "cover", border: "1px solid var(--border)", borderRadius: "var(--r-md)", flex: "none" }}
          />
        )}
        <div className="kv" style={{ flex: 1 }}>
          <div className="k">Name</div>
          <div>{text(liveProfile?.name) ?? "—"}</div>
          <div className="k">Date of birth</div>
          <div className="num">{text(liveProfile?.dob) ?? "—"}</div>
          <div className="k">Gender</div>
          <div>{genderLabel(liveProfile?.gender) ?? "—"}</div>
          <div className="k">Mobile on ABHA</div>
          <div className="mono">{text(liveProfile?.mobile) ?? "—"}</div>
          <div className="k">Email on ABHA</div>
          <div>{text(liveProfile?.email) ?? "—"}</div>
          <div className="k">Address</div>
          <div>{text(liveProfile?.address) ?? "—"}</div>
          <div className="k">District / state</div>
          <div>{[text(liveProfile?.districtName), text(liveProfile?.stateName)].filter(Boolean).join(", ") || "—"}</div>
        </div>
      </div>

      <div className="inline mt-4">
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          aria-expanded={contactEdit === "mobile"}
          onClick={() => setContactEdit(contactEdit === "mobile" ? null : "mobile")}
        >
          <Phone size={14} aria-hidden />
          Update ABHA mobile
        </button>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          aria-expanded={contactEdit === "email"}
          onClick={() => setContactEdit(contactEdit === "email" ? null : "email")}
        >
          <Mail size={14} aria-hidden />
          Update ABHA email
        </button>
      </div>
      {contactEdit && (
        <div className="mt-3">
          <ContactUpdate
            key={contactEdit}
            patientId={patient.id}
            type={contactEdit}
            environment={environment}
            initialValue={contactEdit === "mobile" ? (patient.phone ?? "") : (patient.email ?? "")}
            intro="Requires the ABHA to be verified in this session."
            onDone={async (value) => {
              // ABDM now holds the new value; keep the hospital's own record in step with it.
              try {
                await updatePatient(patient.id, contactEdit === "mobile" ? { phone: value } : { email: value });
              } catch {
                // the ABHA is updated; the record can still be edited by hand
              }
              onAbhaContactUpdated();
            }}
            onCancel={() => setContactEdit(null)}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * The hospital's own demographic and contact fields. Name, date of birth and gender are fixed (verified against the
 * ABHA); contact and address can be edited and are saved against the patient.
 */
export function HospitalRecordCard({
  patient,
  onPatientUpdated,
}: {
  patient: BackendPatientWithAbha;
  onPatientUpdated: (patient: BackendPatientWithAbha) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MappedErrorState | null>(null);
  const [form, setForm] = useState({ phone: "", email: "", address: "", stateName: "", districtName: "" });

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function startEditing() {
    setForm({
      phone: patient.phone ?? "",
      email: patient.email ?? "",
      address: patient.address ?? "",
      stateName: patient.stateName ?? "",
      districtName: patient.districtName ?? "",
    });
    setError(null);
    setEditing(true);
  }

  async function save() {
    setError(null);
    const phoneIssue = mobileProblem(form.phone);
    if (phoneIssue) {
      setError({ tone: "error", title: "Wrong mobile number", body: phoneIssue });
      return;
    }
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) {
      setError({ tone: "error", title: "Invalid email address", body: "Enter a valid email address, or leave it empty." });
      return;
    }

    // Only what changed is sent.
    const changes: Parameters<typeof updatePatient>[1] = {};
    if (form.phone !== (patient.phone ?? "")) changes.phone = form.phone;
    if (form.email !== (patient.email ?? "")) changes.email = form.email;
    if (form.address !== (patient.address ?? "")) changes.address = form.address;
    if (form.stateName !== (patient.stateName ?? "")) changes.stateName = form.stateName;
    if (form.districtName !== (patient.districtName ?? "")) changes.districtName = form.districtName;
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const res = await updatePatient(patient.id, changes);
      onPatientUpdated({ ...patient, ...res.data, abha: patient.abha ?? null });
      setEditing(false);
    } catch (err) {
      setError(mapApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Demographics and contact"
      icon={UserRound}
      actions={
        !editing && (
          <button className="btn btn-sm btn-ghost" type="button" onClick={startEditing}>
            <Pencil size={13} aria-hidden />
            Edit
          </button>
        )
      }
    >
      {error && (
        <div className="mb-3">
          <StopState {...error} />
        </div>
      )}
      {!editing ? (
        <div className="kv">
          <div className="k">Name</div>
          <div>
            {patient.name}
            <Fixed />
          </div>
          <div className="k">Date of birth</div>
          <div className="num">
            {patient.dateOfBirth ?? "—"}
            <Fixed />
          </div>
          <div className="k">Gender</div>
          <div>
            {genderLabel(patient.gender) ?? "—"}
            <Fixed />
          </div>
          <div className="k">Mobile</div>
          <div className="mono">{patient.phone ? `+91 ${patient.phone}` : "—"}</div>
          <div className="k">Email</div>
          <div>{patient.email ?? "—"}</div>
          <div className="k">Address</div>
          <div>{patient.address ?? "—"}</div>
          <div className="k">District</div>
          <div>{patient.districtName ?? "—"}</div>
          <div className="k">State</div>
          <div>{patient.stateName ?? "—"}</div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field">
            <label htmlFor="rec-phone">Mobile</label>
            <div className="mobile-wrap">
              <span className="mobile-prefix">+91</span>
              <input
                id="rec-phone"
                className="input mono"
                inputMode="numeric"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
                disabled={saving}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="rec-email">
              Email <span className="opt">(optional)</span>
            </label>
            <input id="rec-email" className="input" type="email" autoComplete="off" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={saving} />
          </div>
          <div className="field">
            <label htmlFor="rec-address">
              Address <span className="opt">(optional)</span>
            </label>
            <input id="rec-address" className="input" maxLength={300} value={form.address} onChange={(e) => set("address", e.target.value)} disabled={saving} />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="rec-district">District</label>
              <input id="rec-district" className="input" maxLength={80} value={form.districtName} onChange={(e) => set("districtName", e.target.value)} disabled={saving} />
            </div>
            <div className="field">
              <label htmlFor="rec-state">State</label>
              <input id="rec-state" className="input" maxLength={80} value={form.stateName} onChange={(e) => set("stateName", e.target.value)} disabled={saving} />
            </div>
          </div>
          <div className="form-actions end">
            <button className="btn btn-ghost" type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving && <span className="spinner" aria-hidden />}
              {saving ? "Saving" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

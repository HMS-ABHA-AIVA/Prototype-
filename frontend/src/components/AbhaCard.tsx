import { QrCode, UserRound } from "lucide-react";

export interface AbhaCardData {
  name: string;
  abhaNumber: string;
  abhaAddress: string;
  dateOfBirth: string | null;
  gender: string | null;
  /** data: URL or base64 of the photo on the ABHA, when ABDM returned one */
  photo?: string | undefined;
  /** object URL of the live QR image, when it could be loaded */
  qrUrl?: string | undefined;
  facilityName?: string | null | undefined;
}

// DD-MM-YYYY, as on the national ABHA card (the record keeps YYYY-MM-DD)
const formatDob = (value: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (value ?? "—");
};

/**
 * The ABHA card shown on the patient record and printed from it (NHA M1: ABHA number, photo (optional), QR code,
 * date of birth and gender, ABHA address). The "abha-print" class makes it the only thing printed.
 */
export function AbhaCard({ data }: { data: AbhaCardData }) {
  return (
    <article className="abha-print" aria-label="ABHA card">
      <header className="abha-print-head">
        <span className="abha-print-brand">ABHA</span>
        <span className="abha-print-title">Ayushman Bharat Health Account</span>
      </header>

      <div className="abha-print-body">
        <div className="abha-print-photo">
          {data.photo ? <img src={data.photo} alt="Photo on the ABHA" /> : <UserRound size={34} aria-label="No photo on the ABHA" />}
        </div>

        <div className="abha-print-main">
          <div className="abha-print-name">{data.name}</div>
          <dl className="abha-print-fields">
            <div className="abha-print-wide">
              <dt>ABHA number</dt>
              <dd className="abha-print-number">{data.abhaNumber}</dd>
            </div>
            <div className="abha-print-wide">
              <dt>ABHA address</dt>
              <dd className="abha-print-mono">{data.abhaAddress}</dd>
            </div>
            <div>
              <dt>Date of birth</dt>
              <dd>{formatDob(data.dateOfBirth)}</dd>
            </div>
            <div>
              <dt>Gender</dt>
              <dd>{data.gender ?? "—"}</dd>
            </div>
          </dl>
        </div>

        <div className="abha-print-qr">
          {data.qrUrl ? (
            <img src={data.qrUrl} alt="ABHA QR code" />
          ) : (
            <span className="abha-print-qr-empty">
              <QrCode size={20} aria-hidden />
              QR not loaded
            </span>
          )}
        </div>
      </div>

      <footer className="abha-print-foot">
        <span>{data.facilityName ?? ""}</span>
        <span>Printed {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
      </footer>
    </article>
  );
}

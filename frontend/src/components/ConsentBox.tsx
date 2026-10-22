import { CONSENT_LANGUAGES, PRIVACY_POLICY_URL, consentFor, type ConsentKind, type ConsentLanguage } from "@/lib/consentText";

/**
 * Shows the full consent wording (English or Hindi) and a tick box. The Send OTP button stays blocked until it is
 * ticked. The language the patient chose is reported through onLanguageChange and recorded with the transaction.
 */
export function ConsentBox({
  kind,
  language,
  onLanguageChange,
  checked,
  onChange,
  disabled,
}: {
  kind: ConsentKind;
  language: ConsentLanguage;
  onLanguageChange: (language: ConsentLanguage) => void;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const consent = consentFor(kind, language);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{consent.title}</div>
        <div className="seg" role="group" aria-label={consent.languageLabel}>
          {CONSENT_LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={language === l.code ? "on" : ""}
              onClick={() => onLanguageChange(l.code)}
              disabled={disabled}
              lang={l.code}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div
        lang={language}
        style={{
          maxHeight: 150,
          overflowY: "auto",
          border: "1px solid var(--line-2)",
          background: "var(--paper)",
          padding: "8px 12px",
          fontSize: 12,
          color: "var(--text-dim)",
        }}
        tabIndex={0}
        aria-label={consent.title}
      >
        <p style={{ margin: "0 0 6px" }}>{consent.intro}</p>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {consent.points.map((point) => (
            <li key={point} style={{ marginBottom: 4 }}>
              {point}
            </li>
          ))}
        </ol>
      </div>
      <label lang={language} style={{ display: "flex", gap: 8, fontSize: 12.5, marginTop: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        <span>
          {consent.agreePrefix}{" "}
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
            {consent.privacyLinkText}
          </a>
          .
        </span>
      </label>
    </div>
  );
}

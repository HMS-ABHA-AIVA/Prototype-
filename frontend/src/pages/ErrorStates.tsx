import { AlertCircle, Clock, Info } from "lucide-react";

// Inline state block used by the ABHA flows and lists: an error, a pending/expired state, or a neutral message.
// The wording comes from mapApiError (lib/errorHelper.ts), which uses the server's own message where it has one.
export function StopState({
  tone,
  title,
  body,
  action,
}: {
  tone: "error" | "pending" | "none";
  title: string;
  body: string;
  action?: { label: string; onClick?: () => void; ghost?: boolean };
}) {
  const Icon = tone === "error" ? AlertCircle : tone === "pending" ? Clock : Info;
  return (
    <div className={`err-card ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={17} aria-hidden />
      <div style={{ minWidth: 0 }}>
        <div className="t">{title}</div>
        {body && <p>{body}</p>}
        {action && (
          <button type="button" className={`btn btn-sm ${action.ghost ? "btn-ghost" : "btn-primary"}`} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

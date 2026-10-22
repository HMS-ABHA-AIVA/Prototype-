// Shared building blocks for every staff screen. Markup only; styles live in styles/hms.css.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, Info, Inbox, type LucideIcon } from "lucide-react";

/* ---------- Page header ---------- */
export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
}) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {back && (
          <button type="button" className="back-link" onClick={back.onClick}>
            <ChevronLeft size={14} aria-hidden />
            {back.label}
          </button>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/* ---------- Card ---------- */
export function Card({
  title,
  subtitle,
  icon: Icon,
  actions,
  children,
  footer,
  bodyClass = "card-body",
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** "" for edge-to-edge content such as tables */
  bodyClass?: string;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && (
              <h2 className="card-title">
                {Icon && <Icon size={16} aria-hidden />}
                {title}
              </h2>
            )}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="inline">{actions}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

/* ---------- Alert ---------- */
export type AlertTone = "info" | "success" | "warning" | "error" | "neutral";
const ALERT_ICON: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
  neutral: Info,
};

export function Alert({
  tone = "info",
  title,
  children,
  actions,
  className = "",
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`alert ${tone} ${className}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden />
      <div className="alert-body">
        {title && <div className="alert-title">{title}</div>}
        {children && <div className={title ? "alert-text" : undefined}>{children}</div>}
        {actions && <div className="alert-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ---------- Status badge ---------- */
export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "primary" | "reserved";
export function StatusBadge({ tone = "neutral", children, plain }: { tone?: BadgeTone; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone}${plain ? " plain" : ""}`}>{children}</span>;
}

/* ---------- Empty state ---------- */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  text,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={20} aria-hidden />
      </div>
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {action}
    </div>
  );
}

/* ---------- Loading skeletons ---------- */
export function Skeleton({ width = "100%", height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="table-wrap" aria-busy="true" aria-label="Loading">
      <table className="table">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skeleton width={c === 0 ? "70%" : "50%"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Confirmation dialog ---------- */
type ConfirmRequest = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean };

/**
 * `const [confirm, dialog] = useConfirm()`; render `{dialog}` once and `await confirm({...})` where a
 * browser confirm() was used. Resolves true when the user confirms.
 */
export function useConfirm(): [(req: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => {
    setRequest(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }, []);

  const dialog = request ? <ConfirmDialog request={request} onClose={close} /> : null;
  return [confirm, dialog];
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="dialog-head">
          <h2 className="dialog-title" id="confirm-title">
            {request.title}
          </h2>
        </div>
        {request.body && <div className="dialog-body">{request.body}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${request.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => onClose(true)}
          >
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  KeyRound,
  LogOut,
  Menu,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";
import { navByRole, ROLE_LABELS } from "@/hospital/components/layout/navConfig";
import { ChangePasswordDialog } from "@/hospital/modules/auth/ChangePasswordDialog";
import { useNoticeStore } from "@/hospital/store/useNoticeStore";

type NavItem = { key: string; label: string; path: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

const OWNER_NAV: NavGroup[] = [
  { label: "Facility", items: [{ key: "facility", label: "Facility setup", path: "/facility-setup", icon: Building2 }] },
];

const COLLAPSE_KEY = "aiva.nav.collapsed";

/** The hospital's name, returned by the staff login; null for sessions saved before it was returned. */
export function useFacilityName(): string | null {
  const session = useAuthStore((s) => s.session);
  return session?.kind === "staff" ? (session.facilityName ?? null) : null;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

export function AppShell({
  active,
  crumb,
  children,
}: {
  /** key of the navigation entry this screen belongs to */
  active: string;
  /** extra breadcrumb after the section, e.g. the open patient's name */
  crumb?: string;
  children: ReactNode;
  // Older callers still pass these; the shell now reads them from the session itself.
  onNavigate?: (key: string) => void;
  facilityName?: string;
  env?: "Sandbox" | "Production";
  staffName?: string;
  staffEmail?: string;
  onLogout?: () => void;
}) {
  const facility = useFacilityName();
  const session = useAuthStore((s) => s.session);
  const role = session?.kind === "staff" ? session.role : "front_office";
  const groups: NavGroup[] = navByRole[role].map((section) => ({ label: section.section, items: section.items }));

  return (
    <Shell groups={groups} active={active} crumb={crumb} facility={facility} roleLabel={ROLE_LABELS[role]} canChangePassword>
      {children}
    </Shell>
  );
}

// The facility owner's login: only the facility setup screen.
export function OwnerShell({ children }: { children: ReactNode; facilityName?: string; onLogout?: () => void }) {
  const session = useAuthStore((s) => s.session);
  return (
    <Shell groups={OWNER_NAV} active="facility" facility={session?.name ?? null} roleLabel="Facility owner">
      {children}
    </Shell>
  );
}

function Shell({
  groups,
  active,
  crumb,
  facility,
  roleLabel,
  canChangePassword = false,
  children,
}: {
  groups: NavGroup[];
  active: string;
  crumb?: string | undefined;
  facility: string | null;
  roleLabel: string;
  /** Staff choose their own password; the facility owner's login is managed elsewhere. */
  canChangePassword?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { session, environment, signOut } = useAuthStore();
  const notice = useNoticeStore();
  const [changingPassword, setChangingPassword] = useState(false);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [navOpen, setNavOpen] = useState(false); // small screens: sidebar as a drawer

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // preference just won't persist
      }
      return !c;
    });
  }

  const current = groups.flatMap((g) => g.items.map((it) => ({ group: g.label, it }))).find((x) => x.it.key === active);
  const production = environment === "PRODUCTION";

  return (
    <div className={`app${collapsed ? " collapsed" : ""}${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden>
            <Stethoscope size={17} />
          </div>
          <div className="brand-text">
            <div className="brand-name">AIVA OSHealth</div>
            <div className="brand-sub" title={facility ?? undefined}>
              {facility ?? "Hospital information system"}
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((it) => {
                const Icon = it.icon;
                const isActive = it.key === active;
                return (
                  <a
                    key={it.key}
                    href={it.path}
                    className={`nav-link${isActive ? " active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    data-tip={it.label}
                    aria-label={collapsed ? it.label : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // allow open-in-new-tab
                      e.preventDefault();
                      setNavOpen(false);
                      navigate(it.path);
                    }}
                  >
                    <Icon size={18} aria-hidden />
                    <span className="nav-label">{it.label}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-link collapse-toggle"
            onClick={toggleCollapsed}
            data-tip={collapsed ? "Expand menu" : undefined}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          >
            {collapsed ? <ChevronsRight size={18} aria-hidden /> : <ChevronsLeft size={18} aria-hidden />}
            <span className="nav-label">Collapse menu</span>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />

      <div className="workspace">
        <header className="topbar">
          <button type="button" className="icon-btn topbar-menu" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <nav className="crumbs" aria-label="Breadcrumb">
            {current && (
              <>
                <span className="nowrap crumb-group">{current.group}</span>
                <ChevronRight size={14} aria-hidden className="crumb-group" />
                {crumb ? (
                  <>
                    <a href={current.it.path} onClick={(e) => (e.preventDefault(), navigate(current.it.path))} className="nowrap">
                      {current.it.label}
                    </a>
                    <ChevronRight size={14} aria-hidden />
                    <span className="crumb-current" aria-current="page">
                      {crumb}
                    </span>
                  </>
                ) : (
                  <span className="crumb-current" aria-current="page">
                    {current.it.label}
                  </span>
                )}
              </>
            )}
            {!current && crumb && (
              <span className="crumb-current" aria-current="page">
                {crumb}
              </span>
            )}
          </nav>
          <div className="topbar-spacer" />
          <div className="topbar-right">
            <span
              className={`env-badge${production ? " production" : ""}`}
              title={production ? "ABHA calls go to the live ABDM environment" : "ABHA calls go to the ABDM sandbox"}
            >
              <span className="env-k">ABDM</span>
              {production ? "Production" : "Sandbox"}
            </span>
            <UserMenu
              name={session?.name ?? ""}
              email={session?.email ?? ""}
              roleLabel={roleLabel}
              onSignOut={signOut}
              onChangePassword={canChangePassword ? () => setChangingPassword(true) : undefined}
            />
          </div>
        </header>
        <main className="content" id="main">
          <div className="content-inner">{children}</div>
        </main>
      </div>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
      {notice.message && (
        <div className={`toast ${notice.kind}`} role="alert" onClick={notice.clear}>
          {notice.message}
        </div>
      )}
    </div>
  );
}

function UserMenu({
  name,
  email,
  roleLabel,
  onSignOut,
  onChangePassword,
}: {
  name: string;
  email: string;
  roleLabel: string;
  onSignOut: () => void;
  onChangePassword?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>
          {initials(name)}
        </span>
        <span className="user-meta">
          <span className="user-name" style={{ display: "block" }}>
            {name}
          </span>
          <span className="user-role" style={{ display: "block" }}>
            {roleLabel}
          </span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="user-name">{name}</div>
            <div className="menu-email">{email}</div>
            <div className="user-role" style={{ marginTop: 4 }}>
              {roleLabel}
            </div>
          </div>
          {onChangePassword && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onChangePassword();
              }}
            >
              <KeyRound size={15} aria-hidden />
              Change password
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item danger" onClick={onSignOut}>
            <LogOut size={15} aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

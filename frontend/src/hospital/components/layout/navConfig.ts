import {
  BedDouble,
  BookOpen,
  Building2,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FlaskConical,
  Hotel,
  KeyRound,
  LayoutDashboard,
  Package,
  Pill,
  QrCode,
  Receipt,
  Recycle,
  ScrollText,
  Siren,
  Sparkles,
  Syringe,
  Tags,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '../../types';

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
}

export interface NavSection {
  section: string;
  items: NavItem[];
}

const ALL = {
  dashboard: { key: 'dashboard', label: 'Dashboard', path: '/', icon: LayoutDashboard },
  // Registration and ABHA (ABDM M1)
  patients: { key: 'registration', label: 'Patient register', path: '/registration', icon: Users },
  register: { key: 'register', label: 'New registration', path: '/register', icon: UserPlus },
  shared: { key: 'shared', label: 'Scan & Share queue', path: '/shared-profiles', icon: QrCode },
  // Hospital modules
  opd: { key: 'opd', label: 'OPD queue', path: '/opd', icon: ClipboardList },
  opdBilling: { key: 'opd-billing', label: 'OPD billing', path: '/opd-billing', icon: CreditCard },
  emergency: { key: 'emergency', label: 'Emergency', path: '/emergency', icon: Siren },
  ipd: { key: 'ipd', label: 'IPD / bed board', path: '/ipd', icon: BedDouble },
  medicineRound: { key: 'medication-round', label: 'Medicine round', path: '/medication-round', icon: Syringe },
  lab: { key: 'lab', label: 'Lab & radiology', path: '/lab', icon: FlaskConical },
  ipdBilling: { key: 'ipd-billing', label: 'IPD billing', path: '/ipd-billing', icon: Hotel },
  billing: { key: 'billing', label: 'Bills', path: '/billing', icon: Receipt },
  panels: { key: 'panels', label: 'Panels & rates', path: '/panels', icon: Tags },
  pharmacy: { key: 'pharmacy', label: 'Pharmacy & inventory', path: '/pharmacy', icon: Pill },
  supplies: { key: 'supplies', label: 'Supplies', path: '/supplies', icon: Package },
  housekeeping: { key: 'housekeeping', label: 'Housekeeping', path: '/housekeeping', icon: Sparkles },
  waste: { key: 'waste', label: 'Bio-medical waste', path: '/housekeeping/waste', icon: Recycle },
  roster: { key: 'roster', label: 'Staff roster', path: '/roster', icon: CalendarClock },
  payroll: { key: 'payroll', label: 'Payroll & HR', path: '/payroll', icon: Wallet },
  masters: { key: 'masters', label: 'Masters', path: '/masters', icon: BookOpen },
  facility: { key: 'facility', label: 'Facility profile', path: '/facility', icon: Building2 },
  access: { key: 'access', label: 'Staff access', path: '/access', icon: KeyRound },
  audit: { key: 'audit', label: 'Audit log', path: '/audit', icon: ScrollText },
} satisfies Record<string, NavItem>;

const overview: NavSection = { section: 'Overview', items: [ALL.dashboard] };
// The ABDM M1 screens (registration, ABHA, Scan & Share): the front desk, clinicians, billing and administrators.
const patients: NavSection = { section: 'Patients & ABHA', items: [ALL.patients, ALL.register, ALL.shared] };

export const navByRole: Record<Role, NavSection[]> = {
  front_office: [
    overview,
    patients,
    { section: 'Front office', items: [ALL.opdBilling, ALL.ipdBilling, ALL.lab, ALL.supplies, ALL.roster] },
    { section: 'Visibility', items: [ALL.opd, ALL.emergency, ALL.ipd, ALL.housekeeping, ALL.waste] },
  ],
  doctor: [overview, patients, { section: 'Clinical', items: [ALL.opd, ALL.emergency, ALL.ipd, ALL.lab] }],
  nurse: [
    overview,
    patients,
    { section: 'Ward', items: [ALL.emergency, ALL.ipd, ALL.medicineRound, ALL.lab, ALL.ipdBilling] },
    { section: 'Operations', items: [ALL.supplies, ALL.housekeeping, ALL.waste, ALL.roster] },
  ],
  pharmacist: [overview, { section: 'Workspace', items: [ALL.pharmacy] }],
  biller: [overview, patients, { section: 'Billing', items: [ALL.opdBilling, ALL.ipdBilling, ALL.lab, ALL.billing] }],
  housekeeping: [overview, { section: 'Workspace', items: [ALL.housekeeping, ALL.waste, ALL.roster] }],
  lab: [overview, { section: 'Workspace', items: [ALL.lab] }],
  admin: [
    overview,
    patients,
    { section: 'Clinical', items: [ALL.opdBilling, ALL.opd, ALL.emergency, ALL.ipd, ALL.medicineRound, ALL.lab] },
    { section: 'Billing', items: [ALL.ipdBilling, ALL.billing, ALL.panels] },
    { section: 'Operations', items: [ALL.pharmacy, ALL.supplies, ALL.housekeeping, ALL.waste] },
    { section: 'People', items: [ALL.roster, ALL.payroll] },
    { section: 'Setup', items: [ALL.masters, ALL.facility, ALL.access, ALL.audit] },
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  front_office: 'Front office',
  doctor: 'Doctor',
  nurse: 'Nurse',
  pharmacist: 'Pharmacist',
  biller: 'Billing',
  housekeeping: 'Housekeeping',
  lab: 'Lab & radiology',
  admin: 'Administrator',
};

/** Screens reached from inside others rather than from the menu (a patient's chart and record, a stay's bill ...). */
const EXTRA_PATHS: Partial<Record<Role, string[]>> = {
  front_office: ['/emr', '/record'],
  doctor: ['/emr', '/record', '/ipd-billing', '/medication-round'],
  nurse: ['/emr', '/record'],
  biller: ['/record'],
  admin: ['/emr', '/record'],
};

/** Whether this role has the screen in its menu (screens opened from inside others are handled by canOpenPath). */
export const canOpen = (role: Role, path: string) => navByRole[role].some((section) => section.items.some((item) => item.path === path));

/**
 * Whether this role may open a page (the menu's screens, and the ones opened from inside them). The server enforces the same
 * rules; this only keeps people from landing on a screen that would refuse them.
 */
export function canOpenPath(role: Role, pathname: string): boolean {
  if (pathname === '/') return true;
  const paths = [...navByRole[role].flatMap((s) => s.items.map((i) => i.path)), ...(EXTRA_PATHS[role] ?? [])];
  return paths.some((path) => path !== '/' && (pathname === path || pathname.startsWith(`${path}/`)));
}

/** The menu entry a page belongs to (for the highlighted menu item and the breadcrumb). */
export function navKeyFor(role: Role, pathname: string): string | undefined {
  const items = navByRole[role].flatMap((s) => s.items).filter((i) => i.path !== '/');
  const best = items
    .filter((i) => pathname === i.path || pathname.startsWith(`${i.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (best) return best.key;
  if (pathname === '/') return 'dashboard';
  if (pathname.startsWith('/emr') || pathname.startsWith('/record')) return 'registration';
  return undefined;
}


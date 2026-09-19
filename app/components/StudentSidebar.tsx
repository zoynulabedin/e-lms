import { useEffect, useRef, useState } from "react";
import { Link, Form } from "react-router";
import {
  LayoutDashboard,
  GraduationCap,
  FolderOpen,
  HelpCircle,
  Settings,
  LogOut,
  Key,
  ArrowRight,
  Youtube,
  ChevronDown,
  Mail,
  Menu,
  X,
} from "lucide-react";

export type StudentNavItem =
  | "dashboard"
  | "my-courses"
  | "watch"
  | "resources"
  | "help"
  | "browse"
  | "certificates"
  | "quiz-history"
  | "settings"
  | "signout";

interface StudentSidebarProps {
  user: { name: string; email: string };
  active: StudentNavItem;
  /** When true, the Certificates nav item becomes an active link. */
  certificatesEnabled?: boolean;
}

// ── Internal nav item ───────────────────────────────────────────────────────

function NavItem({
  icon: Icon,
  label,
  to,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  to?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const base =
    "relative w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors";
  if (disabled) {
    return (
      <span
        className={`${base} text-white/35 cursor-not-allowed`}
        title="Coming soon"
      >
        <Icon size={18} />
        {label}
      </span>
    );
  }
  return (
    <Link
      to={to ?? "#"}
      onClick={onClick}
      className={`${base} ${
        active
          ? "bg-brand-green-dark text-white font-semibold"
          : "text-white/75 hover:bg-brand-green-dark hover:text-white"
      }`}
    >
      <Icon size={18} />
      {label}
    </Link>
  );
}

// ── Shared sidebar content (desktop aside + mobile drawer) ──────────────────

const NAV_LINK =
  "relative w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors";

function SidebarContent({
  active,
  onNavigate,
  showSettings = false,
}: {
  active?: StudentNavItem;
  onNavigate?: () => void;
  /** The mobile drawer has no top-bar profile menu, so it lists Settings here. */
  showSettings?: boolean;
}) {
  return (
    <>
      <nav className="flex-1 min-h-0 overflow-y-auto px-4 pt-6 pb-6 space-y-1">
        <NavItem
          icon={LayoutDashboard}
          label="Dashboard"
          to="/student"
          active={active === "dashboard"}
          onClick={onNavigate}
        />
        <NavItem
          icon={GraduationCap}
          label="My Course"
          to="/student#my-courses"
          active={active === "my-courses"}
          onClick={onNavigate}
        />
        <a
          href="https://www.youtube.com/@TeachMeLikeATot"
          target="_blank"
          rel="noopener noreferrer"
          onClick={onNavigate}
          className={`${NAV_LINK} ${
            active === "watch"
              ? "bg-brand-green-dark text-white font-semibold"
              : "text-white/75 hover:bg-brand-green-dark hover:text-white"
          }`}
        >
          <Youtube size={18} />
          Watch &amp; Learn
        </a>
        <NavItem
          icon={FolderOpen}
          label="Resources"
          to="/student/resources"
          active={active === "resources"}
          onClick={onNavigate}
        />
        <NavItem
          icon={HelpCircle}
          label="Help & Support"
          to="/student/help"
          active={active === "help"}
          onClick={onNavigate}
        />
        {showSettings && (
          <NavItem
            icon={Settings}
            label="Settings"
            to="/student/settings"
            active={active === "settings"}
            onClick={onNavigate}
          />
        )}

        <Form method="post" action="/auth/logout">
          <button
            type="submit"
            className={`${NAV_LINK} text-white/75 hover:bg-brand-green-dark hover:text-white`}
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </Form>
      </nav>

      {/* License key callout — pinned to the bottom */}
      <div className="mt-auto shrink-0 mx-4 mb-6 rounded-xl bg-brand-mustard/15 border border-brand-mustard/40 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Key size={16} className="text-brand-mustard" />
          <p className="text-sm font-bold text-white">Have a License Key?</p>
        </div>
        <p className="text-xs text-white/70 leading-relaxed mb-3">
          Don't see a course you purchased? Enter your access key to unlock it
          instantly.
        </p>
        <Link
          to="/redeem"
          onClick={onNavigate}
          className="inline-flex items-center justify-center w-full gap-1.5 bg-brand-mustard hover:bg-brand-mustard/90 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
        >
          Redeem Key
          <ArrowRight size={12} />
        </Link>
      </div>
    </>
  );
}

// ── Desktop sidebar ─────────────────────────────────────────────────────────

export function StudentSidebar({ active }: StudentSidebarProps) {
  return (
    <aside className="hidden lg:flex w-72 shrink-0 h-screen sticky top-0 bg-brand-navy-deeper border-r border-white/10 flex-col">
      {/* Logo */}
      <div className="border-b border-white/10">
        <Link to="/student" className="flex items-center group">
          <img
            src="/std-dashboard-img/Logo.png"
            alt="Teach Me Like a Tot"
            className="h-32 w-auto object-contain"
          />
        </Link>
      </div>
      <SidebarContent active={active} />
    </aside>
  );
}

// ── Mobile top bar: logo + hamburger that opens the sidebar as a drawer ─────

export function StudentMobileTopbar({ active }: { active?: StudentNavItem } = {}) {
  const [open, setOpen] = useState(false);

  // Escape closes; lock page scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div className="lg:hidden bg-brand-navy-deeper border-b border-white/10 pr-3 flex items-center justify-between sticky top-0 z-30">
        <Link to="/student" className="flex items-center">
          <img
            src="/std-dashboard-img/Logo.png"
            alt="Teach Me Like a Tot"
            className="h-16 w-auto object-contain"
          />
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="student-mobile-nav"
          className="w-11 h-11 -mr-1 rounded-lg flex items-center justify-center text-white/90 hover:bg-white/10 transition-colors"
        >
          <Menu size={24} />
        </button>
      </div>

      {/* Drawer */}
      <div
        className={`lg:hidden fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
        aria-hidden={!open}
      >
        {/* Backdrop */}
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
        />
        {/* Panel */}
        <div
          id="student-mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className={`absolute inset-y-0 left-0 w-[85vw] max-w-xs bg-brand-navy-deeper border-r border-white/10 shadow-2xl flex flex-col transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-white/10 pr-2">
            <Link to="/student" onClick={() => setOpen(false)} className="flex items-center">
              <img
                src="/std-dashboard-img/Logo.png"
                alt="Teach Me Like a Tot"
                className="h-20 w-auto object-contain"
              />
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white/80 hover:bg-white/10 transition-colors"
            >
              <X size={22} />
            </button>
          </div>
          <SidebarContent active={active} onNavigate={() => setOpen(false)} showSettings />
        </div>
      </div>
    </>
  );
}

// ── Top bar with user profile pill (desktop) ────────────────────────────────

export function StudentTopbar({
  user,
  title,
  subtitle,
}: {
  user: { name: string; email: string };
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const initials = user.name
    .split(" ")
    .map((p) => p.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="hidden lg:flex items-center justify-between gap-4 px-8 py-4 border-b border-brand-beige-dark bg-[#FAEDE8] sticky top-0 z-20">
      {/* Left: optional title/subtitle */}
      <div className="min-w-0 flex-1">
        {title && (
          <h1 className="font-display text-2xl xl:text-3xl text-brand-navy leading-tight truncate">
            {title}
          </h1>
        )}
        {subtitle && (
          <p className="text-black text-sm mt-0.5 truncate">
            {subtitle}
          </p>
        )}
      </div>

      {/* Right: user pill */}
      <div className="shrink-0">
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 bg-white hover:bg-white/80 border border-brand-beige-dark rounded-full pl-1 pr-2 py-1 transition-colors"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={user.name}
          title={user.name}
        >
          <div className="w-8 h-8 rounded-full bg-brand-navy text-white flex items-center justify-center font-bold text-xs shrink-0">
            {initials}
          </div>
          <ChevronDown
            size={14}
            className={`text-brand-navy/50 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-white border border-brand-beige-dark shadow-lg overflow-hidden z-30"
          >
            <div className="px-4 py-3 border-b border-brand-beige-dark bg-brand-beige/40 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-brand-navy text-white flex items-center justify-center font-bold text-sm shrink-0">
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-sm text-brand-navy truncate flex items-center gap-1.5">
                  <Mail size={13} className="shrink-0 text-brand-navy/60" />
                  {user.email}
                </p>
              </div>
            </div>
            <div className="p-1">
              <Link
                to="/student/settings"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-brand-navy hover:bg-brand-green-dark hover:text-white font-medium transition-colors"
              >
                <Settings size={15} />
                Settings
              </Link>
              <Form method="post" action="/auth/logout">
                <button
                  type="submit"
                  role="menuitem"
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-brand-navy hover:bg-brand-green-dark hover:text-white font-medium transition-colors"
                >
                  <LogOut size={15} />
                  Sign Out
                </button>
              </Form>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

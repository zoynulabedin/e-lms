import { useEffect, useRef, useState } from "react";
import { Link, Form } from "react-router";
import {
  LayoutDashboard,
  Search,
  Award,
  BookOpen,
  Settings,
  HelpCircle,
  LogOut,
  Key,
  ArrowRight,
  Youtube,
  ChevronDown,
  Mail,
} from "lucide-react";

export type StudentNavItem =
  | "dashboard"
  | "browse"
  | "content"
  | "certificates"
  | "quiz-history"
  | "settings"
  | "help"
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
}: {
  icon: React.ElementType;
  label: string;
  to?: string;
  active?: boolean;
  disabled?: boolean;
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

// ── Sidebar ─────────────────────────────────────────────────────────────────

export function StudentSidebar({
  active,
  certificatesEnabled = false,
}: StudentSidebarProps) {
  const activeBase =
    "relative w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors";

  return (
    <aside className="hidden lg:flex w-72 shrink-0 min-h-screen bg-brand-navy-deeper border-r border-white/10 flex-col">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-white/10">
        <Link to="/student" className="inline-flex items-center group">
          <img
            src="/White_center.avif"
            alt="Teach Me Like a Tot"
            className="h-20 w-auto object-contain"
          />
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-4 py-6 space-y-1">
        <NavItem
          icon={LayoutDashboard}
          label="Dashboard"
          to="/student"
          active={active === "dashboard"}
        />
        <NavItem
          icon={Search}
          label="Browse Courses"
          to="/catalog"
          active={active === "browse"}
        />
        <a
          href="https://www.youtube.com/@TeachMeLikeATot"
          target="_blank"
          rel="noopener noreferrer"
          className={`${activeBase} ${
            active === "content"
              ? "bg-brand-green-dark text-white font-semibold"
              : "text-white/75 hover:bg-brand-green-dark hover:text-white"
          }`}
        >
          <Youtube size={18} />
          Content
        </a>
        {certificatesEnabled ? (
          <NavItem
            icon={Award}
            label="Certificates"
            to="/student/certificates"
            active={active === "certificates"}
          />
        ) : (
          <NavItem icon={Award} label="Certificates" disabled />
        )}
        <NavItem
          icon={BookOpen}
          label="Quiz History"
          to="/student/quiz-history"
          active={active === "quiz-history"}
        />
        <NavItem icon={Settings} label="Settings" disabled />
        <NavItem
          icon={HelpCircle}
          label="Help & Support"
          to="/student/help"
          active={active === "help"}
        />

        <Form method="post" action="/auth/logout">
          <button
            type="submit"
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-white/75 hover:bg-brand-green-dark hover:text-white transition-colors"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </Form>
      </nav>

      {/* License key callout */}
      <div className="mx-4 mb-6 rounded-xl bg-brand-mustard/15 border border-brand-mustard/40 p-4">
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
          className="inline-flex items-center justify-center w-full gap-1.5 bg-brand-mustard hover:bg-brand-mustard/90 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
        >
          Redeem Key
          <ArrowRight size={12} />
        </Link>
      </div>

    </aside>
  );
}

// ── Mobile top bar (matches sidebar) ───────────────────────────────────────

export function StudentMobileTopbar() {
  return (
    <div className="lg:hidden bg-brand-navy-deeper border-b border-white/10 px-5 py-4 flex items-center justify-between">
      <Link to="/student" className="flex items-center">
        <img
          src="/White_center.avif"
          alt="Teach Me Like a Tot"
          className="h-10 w-auto object-contain"
        />
      </Link>
      <Form method="post" action="/auth/logout">
        <button
          type="submit"
          className="flex items-center gap-1.5 text-white/80 text-sm"
        >
          <LogOut size={16} /> Sign out
        </button>
      </Form>
    </div>
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
          <p className="text-brand-navy/60 text-sm mt-0.5 truncate">
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
          className="flex items-center gap-2.5 bg-white hover:bg-white/80 border border-brand-beige-dark rounded-full pl-1 pr-3 py-1 transition-colors"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <div className="w-8 h-8 rounded-full bg-brand-navy text-white flex items-center justify-center font-bold text-xs shrink-0">
            {initials}
          </div>
          <span className="text-brand-navy text-sm font-semibold leading-none">
            {user.name}
          </span>
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
                <p className="text-sm font-semibold text-brand-navy truncate">
                  {user.name}
                </p>
                <p className="text-xs text-brand-navy/60 truncate flex items-center gap-1">
                  <Mail size={11} />
                  {user.email}
                </p>
              </div>
            </div>
            <div className="p-1">
              <Form method="post" action="/auth/logout">
                <button
                  type="submit"
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

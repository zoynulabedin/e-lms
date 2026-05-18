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
  user,
  active,
  certificatesEnabled = false,
}: StudentSidebarProps) {
  const initials = user.name
    .split(" ")
    .map((p) => p.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();

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

      {/* User footer */}
      <div className="px-6 py-4 border-t border-white/10 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-mustard text-white flex items-center justify-center font-bold text-sm shrink-0">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">
            {user.name}
          </p>
          <p className="text-xs text-white/60 truncate">{user.email}</p>
        </div>
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

import { Outlet, NavLink, Form, useLoaderData } from "react-router";
import { Toast } from "../components/Toast";
import { redirect } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import {
  LayoutDashboard,
  BookText,
  Key,
  Settings,
  Bell,
  Store,
  Users,
  BarChart2,
  LogOut,
  Menu,
  X,
  Globe,
  Shield,
  HelpCircle,
} from "lucide-react";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAdmin(request);
  return { user };
}

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/courses", label: "Courses", icon: BookText },
  { to: "/licenses", label: "License Keys", icon: Key },
  { to: "/sessions", label: "Sessions", icon: Shield },
  { to: "/users", label: "Users", icon: Users },
  { to: "/quiz-review", label: "Quiz Review", icon: HelpCircle },
  { to: "/reports", label: "Reports", icon: BarChart2 },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/catalog", label: "Student Catalog", icon: Globe },
];

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  onClick,
}: {
  to: string;
  label: string;
  icon: React.ElementType;
  end?: boolean;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
          isActive
            ? "bg-brand-navy/10 text-brand-navy shadow-sm"
            : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        }`
      }
    >
      <Icon size={18} />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const { user } = useLoaderData<typeof loader>();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen bg-brand-beige overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:relative z-50 md:z-auto inset-y-0 left-0 w-64 bg-white border-r border-gray-200 flex flex-col transform transition-transform duration-200 ease-in-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* Logo */}
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-lg bg-brand-navy flex items-center justify-center shadow-sm p-1.5">
              <img
                src="/White_center.avif"
                alt="Teach Me Like a Tot"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <p className="text-sm font-bold text-gray-900 leading-none">
                E-Course Admin
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                Teach Me Like a Tot
              </p>
            </div>
          </div>
          <button
            className="md:hidden text-gray-400"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              onClick={() => setMobileOpen(false)}
            />
          ))}
        </nav>

        {/* User footer */}
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-brand-navy text-white flex items-center justify-center font-bold text-xs shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {user.name}
              </p>
              <p className="text-xs text-gray-500 truncate">{user.email}</p>
            </div>
          </div>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="w-full flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 px-3 py-2 rounded-lg transition-colors"
            >
              <LogOut size={16} /> Sign out
            </button>
          </Form>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-4">
            <button
              className="md:hidden text-gray-500 hover:text-gray-700"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200">
              <div className="w-2 h-2 rounded-full bg-brand-navy animate-pulse" />
              <span className="text-xs font-medium text-green-800">
                Store Active
              </span>
            </div>
            <button className="text-gray-400 hover:text-gray-600 transition-colors">
              <Bell className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Page */}
        <main className="flex-1 overflow-y-auto bg-brand-beige p-6">
          <Outlet />
        </main>
      </div>
      <Toast />
    </div>
  );
}

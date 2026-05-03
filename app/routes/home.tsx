import { useLoaderData } from "react-router";
import { Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import {
  Users,
  Key,
  Award,
  BookOpen,
  CheckCircle2,
  Clock,
  DollarSign,
  UserPlus,
  ArrowRight,
  BarChart2,
  Activity,
} from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalStudents,
    newStudentsThisMonth,
    activeLicenses,
    pendingLicenses,
    completedProgress,
    totalProgress,
    totalCourses,
    publishedCourses,
    recentActivity,
    topCourses,
    enrollmentTrend,
    revenueResult,
  ] = await Promise.all([
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.user.count({
      where: { role: "STUDENT", createdAt: { gte: thirtyDaysAgo } },
    }),
    prisma.license.count({ where: { status: "ACTIVE" } }),
    prisma.license.count({ where: { status: "PENDING" } }),
    prisma.progress.count({ where: { isCompleted: true } }),
    prisma.progress.count(),
    prisma.course.count(),
    prisma.course.count({ where: { status: "PUBLISHED" } }),
    prisma.license.findMany({
      orderBy: { redeemedAt: "desc" },
      take: 8,
      include: {
        course: { select: { title: true } },
        user: { select: { name: true } },
      },
      where: { redeemedAt: { not: null } },
    }),
    prisma.course.findMany({
      take: 5,
      include: {
        _count: { select: { licenses: true, progress: true } },
      },
      orderBy: { licenses: { _count: "desc" } },
    }),
    prisma.$queryRaw<Array<{ day: string; count: bigint }>>`
      SELECT DATE("redeemedAt") as day, COUNT(*) as count
      FROM "License"
      WHERE "redeemedAt" >= NOW() - INTERVAL '14 days'
        AND "redeemedAt" IS NOT NULL
      GROUP BY DATE("redeemedAt")
      ORDER BY day ASC
    `,
    prisma.$queryRaw<Array<{ total: string | null }>>`
      SELECT COALESCE(SUM(c.price), 0)::text as total
      FROM "License" l
      JOIN "Course" c ON l."courseId" = c.id
      WHERE l.status = 'ACTIVE'
        AND c."courseType" = 'PAID'
        AND c.price IS NOT NULL
    `,
  ]);

  const completionRate =
    totalProgress > 0
      ? Math.round((completedProgress / totalProgress) * 100)
      : 0;
  const revenue = parseFloat(revenueResult[0]?.total ?? "0");

  // Build 14-day trend array, zero-filling missing days
  const trendMap = new Map<string, number>();
  enrollmentTrend.forEach((r) => {
    const key = String(r.day).split("T")[0];
    trendMap.set(key, Number(r.count));
  });
  const trend: Array<{ day: string; count: number; label: string }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().split("T")[0];
    trend.push({
      day: key,
      count: trendMap.get(key) ?? 0,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  }

  return {
    stats: {
      totalStudents,
      newStudentsThisMonth,
      activeLicenses,
      pendingLicenses,
      completionRate,
      revenue,
      totalCourses,
      publishedCourses,
      completedProgress,
    },
    recentActivity,
    topCourses,
    trend,
  };
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  iconColor,
  iconBg,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  accent?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-start gap-4">
      <div className={`shrink-0 p-3 rounded-xl ${iconBg}`}>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">
          {label}
        </p>
        <p className="text-2xl font-bold text-gray-900 leading-none">{value}</p>
        {sub && (
          <p className={`text-xs mt-1.5 font-medium ${accent ?? "text-gray-400"}`}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

function timeAgo(date: string | Date) {
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { stats, recentActivity, topCourses, trend } =
    useLoaderData<typeof loader>();

  const maxTrend = Math.max(...trend.map((d) => d.count), 1);
  const totalTrend = trend.reduce((s, d) => s + d.count, 0);

  return (
    <div className="space-y-7">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Welcome back — here's what's happening.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/users"
            className="flex items-center gap-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 px-4 py-2 rounded-lg transition-colors shadow-sm"
          >
            <UserPlus size={15} /> Add User
          </Link>
          <a
            href="/reports/export"
            className="flex items-center gap-2 text-sm font-medium text-white bg-[#2C795A] hover:bg-[#225A43] px-4 py-2 rounded-lg transition-colors shadow-sm"
          >
            <BarChart2 size={15} /> Export Report
          </a>
        </div>
      </div>

      {/* ── KPI cards ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Revenue"
          value={`$${stats.revenue.toLocaleString("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`}
          sub={`from ${stats.activeLicenses} active licenses`}
          icon={DollarSign}
          iconColor="text-emerald-600"
          iconBg="bg-emerald-50"
          accent="text-emerald-600"
        />
        <StatCard
          label="Total Students"
          value={stats.totalStudents}
          sub={`+${stats.newStudentsThisMonth} this month`}
          icon={Users}
          iconColor="text-blue-600"
          iconBg="bg-blue-50"
          accent={
            stats.newStudentsThisMonth > 0 ? "text-blue-600" : "text-gray-400"
          }
        />
        <StatCard
          label="Active Licenses"
          value={stats.activeLicenses}
          sub={`${stats.pendingLicenses} pending redemption`}
          icon={Key}
          iconColor="text-violet-600"
          iconBg="bg-violet-50"
        />
        <StatCard
          label="Completion Rate"
          value={`${stats.completionRate}%`}
          sub={`${stats.completedProgress} courses finished`}
          icon={Award}
          iconColor="text-amber-600"
          iconBg="bg-amber-50"
          accent={
            stats.completionRate >= 50 ? "text-amber-600" : "text-gray-400"
          }
        />
      </div>

      {/* ── Secondary row ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-5">
          <div className="shrink-0 p-3 rounded-xl bg-indigo-50">
            <BookOpen className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Course Library
            </p>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-gray-900">
                {stats.totalCourses}
              </span>
              <span className="text-sm text-gray-400">total</span>
              <span className="text-sm font-semibold text-emerald-600">
                · {stats.publishedCourses} live
              </span>
            </div>
          </div>
          <Link
            to="/courses"
            className="shrink-0 flex items-center gap-1 text-xs text-[#2C795A] font-semibold hover:text-[#225A43] transition-colors"
          >
            Manage <ArrowRight size={12} />
          </Link>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-5">
          <div className="shrink-0 p-3 rounded-xl bg-green-50">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Redemptions (14 days)
            </p>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-gray-900">
                {totalTrend}
              </span>
              <span className="text-sm text-gray-400">licenses activated</span>
            </div>
          </div>
          <Link
            to="/licenses"
            className="shrink-0 flex items-center gap-1 text-xs text-[#2C795A] font-semibold hover:text-[#225A43] transition-colors"
          >
            View all <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {/* ── Chart + Top courses ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                License Redemptions
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">Last 14 days</p>
            </div>
            <span className="text-sm font-bold text-[#2C795A]">
              {totalTrend} total
            </span>
          </div>

          {totalTrend === 0 ? (
            <div className="flex flex-col items-center justify-center h-36 text-gray-300 gap-2">
              <BarChart2 size={28} className="opacity-40" />
              <span className="text-sm">No redemptions in the last 14 days</span>
            </div>
          ) : (
            <div className="flex items-end gap-1 h-36">
              {trend.map((d, i) => (
                <div
                  key={d.day}
                  className="flex-1 flex flex-col items-center gap-1 group"
                >
                  {d.count > 0 && (
                    <span className="text-[10px] text-[#2C795A] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                      {d.count}
                    </span>
                  )}
                  <div
                    className={`w-full rounded-t-sm transition-colors ${
                      d.count > 0
                        ? "bg-[#2C795A]/80 group-hover:bg-[#2C795A]"
                        : "bg-gray-100"
                    }`}
                    style={{
                      height: `${Math.max(
                        (d.count / maxTrend) * 110,
                        d.count > 0 ? 6 : 3,
                      )}px`,
                    }}
                  />
                  {/* Show every other label */}
                  {i % 2 === 0 && (
                    <span className="text-[9px] text-gray-400 hidden sm:block truncate leading-none">
                      {d.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top courses */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold text-gray-900">
              Top Courses
            </h2>
            <Link
              to="/courses"
              className="text-xs text-[#2C795A] hover:text-[#225A43] font-medium transition-colors"
            >
              View all
            </Link>
          </div>

          {topCourses.length === 0 ? (
            <div className="text-center py-8">
              <BookOpen className="mx-auto w-8 h-8 text-gray-200 mb-2" />
              <p className="text-sm text-gray-400">No courses yet.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {topCourses.map((c: any, i: number) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span className="text-xs font-bold text-gray-300 w-4 shrink-0 text-right">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-medium text-gray-800 truncate leading-snug"
                      title={c.title}
                    >
                      {c.title}
                    </p>
                    <div className="mt-1.5 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#2C795A]"
                        style={{
                          width: `${
                            (topCourses[0] as any)._count.licenses > 0
                              ? (c._count.licenses /
                                  (topCourses[0] as any)._count.licenses) *
                                100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-gray-500 shrink-0">
                    {c._count.licenses}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent activity ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Activity size={16} className="text-[#2C795A]" />
            Recent Redemptions
          </h2>
          <Link
            to="/licenses"
            className="text-xs text-[#2C795A] hover:text-[#225A43] font-medium transition-colors flex items-center gap-1"
          >
            All licenses <ArrowRight size={11} />
          </Link>
        </div>

        {recentActivity.length === 0 ? (
          <div className="px-6 py-10 text-center text-gray-400 text-sm">
            <Clock className="mx-auto w-8 h-8 mb-2 opacity-30" />
            No recent redemptions yet.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {recentActivity.map((a: any) => (
              <div
                key={a.id}
                className="flex items-center gap-4 px-6 py-3 hover:bg-gray-50/60 transition-colors"
              >
                <div className="shrink-0 w-8 h-8 rounded-full bg-[#2C795A]/10 text-[#2C795A] flex items-center justify-center font-bold text-xs">
                  {(a.user?.name ?? a.customerEmail).charAt(0).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {a.user?.name ?? (
                      <span className="text-gray-400 font-normal italic">
                        unregistered
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {a.customerEmail}
                  </p>
                </div>

                <div className="hidden sm:block flex-1 min-w-0 text-center">
                  <p
                    className="text-sm text-gray-700 truncate font-medium"
                    title={a.course?.title}
                  >
                    {a.course?.title}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <code className="text-[11px] font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                    {a.key}
                  </code>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {timeAgo(a.redeemedAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

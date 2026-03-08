import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { TrendingUp, Users, Key, BookOpen, Download } from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const [
    totalUsers,
    totalCourses,
    totalLicenses,
    activeLicenses,
    revokedLicenses,
    pendingLicenses,
    completedCourses,
    licensesByDay,
    topCourses,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.course.count(),
    prisma.license.count(),
    prisma.license.count({ where: { status: "ACTIVE" } }),
    prisma.license.count({ where: { status: "REVOKED" } }),
    prisma.license.count({ where: { status: "PENDING" } }),
    prisma.progress.count({ where: { isCompleted: true } }),
    // Licenses created per day (last 7 days)
    prisma.$queryRaw<Array<{ day: string; count: bigint }>>`
      SELECT DATE("createdAt")::text as day, COUNT(*)::bigint as count
      FROM "License"
      WHERE "createdAt" >= NOW() - INTERVAL '7 days'
      GROUP BY DATE("createdAt")
      ORDER BY day ASC
    `,
    // Top courses by license count
    prisma.course.findMany({
      take: 5,
      include: { _count: { select: { licenses: true, progress: true } } },
      orderBy: { licenses: { _count: "desc" } },
    }),
  ]);

  // Zero-fill all 7 days so chart always shows a full week
  const rawMap = new Map(
    licensesByDay.map((r) => [String(r.day).split("T")[0], Number(r.count)]),
  );
  const now = new Date();
  const filledDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    const key = d.toISOString().split("T")[0];
    return {
      day: key,
      count: rawMap.get(key) ?? 0,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
  });

  return {
    stats: {
      totalUsers,
      totalCourses,
      totalLicenses,
      activeLicenses,
      revokedLicenses,
      pendingLicenses,
      completedCourses,
    },
    licensesByDay: filledDays,
    topCourses,
  };
}

export default function Reports() {
  const { stats, licensesByDay, topCourses } = useLoaderData<typeof loader>();

  const completionRate =
    stats.activeLicenses > 0
      ? Math.round((stats.completedCourses / stats.activeLicenses) * 100)
      : 0;

  const maxCount = Math.max(...licensesByDay.map((d) => d.count), 1);

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold text-gray-900">
          Reports & Analytics
        </h1>
        <a
          href="/reports/export"
          className="flex items-center gap-2 text-sm text-[#008060] border border-[#008060]/30 hover:bg-[#008060]/5 px-4 py-2 rounded-lg transition-colors font-medium"
        >
          <Download size={15} /> Export CSV
        </a>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Total Users",
            value: stats.totalUsers,
            icon: Users,
            color: "text-blue-600",
            bg: "bg-blue-50",
            border: "border-blue-100",
          },
          {
            label: "Total Licenses",
            value: stats.totalLicenses,
            icon: Key,
            color: "text-green-600",
            bg: "bg-green-50",
            border: "border-green-100",
          },
          {
            label: "Total Courses",
            value: stats.totalCourses,
            icon: BookOpen,
            color: "text-purple-600",
            bg: "bg-purple-50",
            border: "border-purple-100",
          },
          {
            label: "Completion Rate",
            value: `${completionRate}%`,
            icon: TrendingUp,
            color: "text-amber-600",
            bg: "bg-amber-50",
            border: "border-amber-100",
          },
        ].map((s) => (
          <div
            key={s.label}
            className={`bg-white rounded-xl p-5 border ${s.border} shadow-sm`}
          >
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-gray-900">{s.value}</p>
            <p className="text-sm text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* License Status Breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-5">
            License Status Breakdown
          </h2>
          <div className="space-y-4">
            {[
              {
                label: "Active",
                value: stats.activeLicenses,
                total: stats.totalLicenses,
                color: "bg-green-500",
              },
              {
                label: "Pending",
                value: stats.pendingLicenses,
                total: stats.totalLicenses,
                color: "bg-yellow-400",
              },
              {
                label: "Revoked",
                value: stats.revokedLicenses,
                total: stats.totalLicenses,
                color: "bg-red-500",
              },
            ].map((row) => (
              <div key={row.label}>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="font-medium text-gray-700">{row.label}</span>
                  <span className="text-gray-500">
                    {row.value} / {row.total}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${row.color} transition-all`}
                    style={{
                      width: `${row.total > 0 ? (row.value / row.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Licenses last 7 days bar chart */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-5">
            Licenses Generated (Last 7 Days)
          </h2>
          <div className="flex items-end gap-2 h-40">
            {licensesByDay.map((d) => (
              <div
                key={d.day}
                className="flex-1 flex flex-col items-center gap-1 group"
              >
                <span className="text-xs text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
                  {d.count}
                </span>
                <div
                  className="w-full rounded-t-md bg-[#008060] hover:bg-[#006e52] transition-colors"
                  style={{
                    height: `${(d.count / maxCount) * 130}px`,
                    minHeight: d.count > 0 ? 4 : 2,
                    opacity: d.count === 0 ? 0.15 : 1,
                  }}
                />
                <span className="text-xs text-gray-400 truncate max-w-full">
                  {d.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top Courses Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">
            Top Courses by Enrollment
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["#", "Course", "Total Licenses", "Completions"].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {topCourses.map((c: any, i: number) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 text-gray-400 font-medium">
                    {i + 1}
                  </td>
                  <td className="px-6 py-3 text-gray-900 font-medium">
                    {c.title}
                  </td>
                  <td className="px-6 py-3 text-gray-700">
                    {c._count.licenses}
                  </td>
                  <td className="px-6 py-3 text-gray-700">
                    {c._count.progress}
                  </td>
                </tr>
              ))}
              {topCourses.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-8 text-center text-gray-400"
                  >
                    No courses yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

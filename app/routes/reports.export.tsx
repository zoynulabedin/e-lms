import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";

/**
 * GET /reports/export
 * Streams a CSV of all license data for admin export.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const licenses = await prisma.license.findMany({
    include: {
      course: { select: { id: true, title: true } },
      user: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Quote every cell and neutralise spreadsheet formula injection: a user can
  // name themselves "=HYPERLINK(...)" and Excel would execute it on open.
  const csvCell = (v: unknown) => {
    let str = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
  };

  const header = [
    "License Key",
    "Status",
    "Course",
    "Customer Email",
    "User Name",
    "Created At",
    "Redeemed At",
  ].map(csvCell).join(",");
  const rows = licenses.map((l) =>
    [
      l.key,
      l.status,
      l.course?.title || "",
      l.customerEmail,
      l.user?.name || "",
      new Date(l.createdAt).toISOString(),
      l.redeemedAt ? new Date(l.redeemedAt).toISOString() : "",
    ].map(csvCell).join(","),
  );

  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="licenses-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
}

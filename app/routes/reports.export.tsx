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
    include: { course: true, user: true },
    orderBy: { createdAt: "desc" },
  });

  const header = [
    "License Key",
    "Status",
    "Course",
    "Customer Email",
    "User Name",
    "Created At",
    "Redeemed At",
  ].join(",");
  const rows = licenses.map((l) =>
    [
      l.key,
      l.status,
      `"${(l.course?.title || "").replace(/"/g, '""')}"`,
      l.customerEmail,
      `"${(l.user?.name || "").replace(/"/g, '""')}"`,
      new Date(l.createdAt).toISOString(),
      l.redeemedAt ? new Date(l.redeemedAt).toISOString() : "",
    ].join(","),
  );

  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="licenses-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
}

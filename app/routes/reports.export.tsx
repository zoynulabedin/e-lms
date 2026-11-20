import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { revokeReasonLabel } from "../utils/license";

/**
 * GET /reports/export
 * Streams a CSV of all license data for admin export.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // After a sign-in, land on /reports, not here: a redirect that ends in a
  // download leaves the login tab stuck on "Signing in…".
  await requireAdmin(request, { returnTo: "/reports" });

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
    "User Email",
    "Shopify Order",
    "Shopify Order Number",
    "Amount Paid",
    "Created At",
    "Redeemed At",
    "Revoked Reason",
    "Revoked At",
  ].map(csvCell).join(",");
  const rows = licenses.map((l) => {
    // A restored key keeps no reason, but guard anyway so only revoked rows say why.
    const revoked = l.status === "REVOKED";
    return [
      l.key,
      l.status,
      l.course?.title || "",
      l.customerEmail,
      l.user?.name || "",
      l.user?.email || "",
      l.shopifyOrderId || "",
      l.shopifyOrderName || "", // "#1001" as staff see it in Shopify; blank on older keys
      l.amountPaid != null ? l.amountPaid.toFixed(2) : "", // per key, shop currency; blank = not recorded
      new Date(l.createdAt).toISOString(),
      l.redeemedAt ? new Date(l.redeemedAt).toISOString() : "",
      revoked ? revokeReasonLabel(l.revokedReason) : "",
      revoked && l.revokedAt ? new Date(l.revokedAt).toISOString() : "",
    ].map(csvCell).join(",");
  });

  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="licenses-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
}

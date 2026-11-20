import { data, Form, Link, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { resyncOrder } from "../utils/shopify-orders.server";
import {
  fetchShopifyOrder,
  findShopifyOrderByName,
  shopifyAdminConfigured,
  shopifyAdminOrderUrl,
  ShopifyAdminError,
} from "../utils/shopify-admin.server";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Key,
  RefreshCw,
  Search,
  ShoppingBag,
  X,
} from "lucide-react";

/**
 * Orders: one row per Shopify order the LMS has seen, reconciled against its
 * keys - payment state, what was bought, which courses it maps to, and the
 * seats (in use / invited / still available). From here an admin can open the
 * order in Shopify, list its keys, or re-sync it from Shopify when a webhook
 * delivery was lost.
 */

const PER_PAGE = 25;
const FILTERS = ["all", "attention", "cancelled", "disputed"] as const;
type FilterName = (typeof FILTERS)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const rawFilter = url.searchParams.get("filter") || "all";
  const filter: FilterName = (FILTERS as readonly string[]).includes(rawFilter) ? (rawFilter as FilterName) : "all";
  const rawPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const disputedIds =
    filter === "disputed"
      ? (await prisma.shopifyDispute.findMany({ where: { kind: "chargeback", NOT: { status: "won" } }, select: { orderId: true } })).map((d) => d.orderId)
      : [];
  const qOrder = q.replace(/^#/, "");
  const where = {
    ...(filter === "attention" ? { unmappedAt: { not: null }, cancelledAt: null } : {}),
    ...(filter === "cancelled" ? { cancelledAt: { not: null } } : {}),
    ...(filter === "disputed" ? { orderId: { in: disputedIds } } : {}),
    ...(q
      ? {
          OR: [
            { orderId: qOrder },
            { orderName: { in: [q, qOrder, `#${qOrder}`], mode: "insensitive" as const } },
            { customerEmail: { contains: q, mode: "insensitive" as const } },
            { organization: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const totalCount = await prisma.shopifyOrder.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await prisma.shopifyOrder.findMany({
    where,
    orderBy: { processedAt: "desc" },
    take: PER_PAGE,
    skip: (page - 1) * PER_PAGE,
    select: {
      orderId: true,
      orderName: true,
      customerEmail: true,
      processedAt: true,
      cancelledAt: true,
      financialStatus: true,
      totalPrice: true,
      currency: true,
      lineItems: true,
      unmappedItems: true,
      unmappedAt: true,
      lastSyncedAt: true,
      organization: { select: { id: true, name: true } },
    },
  });
  const ids = rows.map((r) => r.orderId);

  const [statusGroups, invitedGroups, disputes] = await Promise.all([
    prisma.license.groupBy({ by: ["shopifyOrderId", "status"], where: { shopifyOrderId: { in: ids } }, _count: { _all: true } }),
    prisma.license.groupBy({
      by: ["shopifyOrderId"],
      where: { shopifyOrderId: { in: ids }, status: "PENDING", assignedEmail: { not: null } },
      _count: { _all: true },
    }),
    prisma.shopifyDispute.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, kind: true, status: true } }),
  ]);
  const courseIds = new Set<string>();
  for (const r of rows) for (const li of asLines(r.lineItems)) for (const c of li.courseIds) courseIds.add(c);
  const courses = await prisma.course.findMany({ where: { id: { in: Array.from(courseIds) } }, select: { id: true, title: true } });
  const courseTitle = new Map(courses.map((c) => [c.id, c.title]));

  const orders = rows.map((r) => {
    const count = (status: string) =>
      statusGroups.find((g) => g.shopifyOrderId === r.orderId && g.status === status)?._count._all ?? 0;
    const active = count("ACTIVE");
    const pending = count("PENDING");
    const revoked = count("REVOKED");
    const invited = invitedGroups.find((g) => g.shopifyOrderId === r.orderId)?._count._all ?? 0;
    const openDispute = disputes.find((d) => d.orderId === r.orderId && d.kind === "chargeback" && d.status !== "won");
    return {
      orderId: r.orderId,
      orderName: r.orderName,
      customerEmail: r.customerEmail,
      processedAt: r.processedAt,
      cancelled: !!r.cancelledAt,
      financialStatus: r.financialStatus,
      total: r.totalPrice ? `${r.totalPrice} ${r.currency ?? ""}`.trim() : null,
      organization: r.organization,
      lines: asLines(r.lineItems).map((li) => ({
        title: li.title,
        quantity: li.quantity,
        courses: li.courseIds.map((id) => courseTitle.get(id) ?? id),
      })),
      unmapped: r.unmappedAt ? (Array.isArray(r.unmappedItems) ? r.unmappedItems.map(String) : []) : [],
      seats: { active, invited, available: pending - invited, revoked },
      dispute: openDispute ? openDispute.status ?? "open" : null,
      lastSyncedAt: r.lastSyncedAt,
      shopifyUrl: shopifyAdminOrderUrl(r.orderId),
    };
  });

  return { orders, q, filter, page, totalPages, totalCount, canResync: shopifyAdminConfigured() };
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "resync") {
      const orderId = String(formData.get("orderId") || "");
      const order = await fetchShopifyOrder(orderId);
      if (!order) return data({ error: `Shopify has no order with id ${orderId}.` }, { status: 404 });
      const { summary, failed } = await resyncOrder(order);
      console.warn(`[orders] ${admin.email} re-synced Shopify order ${orderId}: ${summary}`);
      return data(
        failed ? { error: `Re-sync of ${order.name ?? orderId} hit a problem - ${summary}` } : { success: true, message: `${order.name ?? orderId} re-synced - ${summary}` },
        { status: failed ? 500 : 200 },
      );
    }
    if (intent === "fetch_by_number") {
      const name = String(formData.get("name") || "").trim();
      if (!name) return data({ error: "Enter an order number, e.g. #1001." }, { status: 400 });
      const order = await findShopifyOrderByName(name);
      if (!order) return data({ error: `Shopify has no order ${name}.` }, { status: 404 });
      const { summary, failed } = await resyncOrder(order);
      console.warn(`[orders] ${admin.email} fetched Shopify order ${order.name ?? order.id}: ${summary}`);
      return data(
        failed ? { error: `Fetching ${order.name ?? name} hit a problem - ${summary}` } : { success: true, message: `${order.name ?? name} fetched from Shopify - ${summary}` },
        { status: failed ? 500 : 200 },
      );
    }
  } catch (e) {
    if (e instanceof ShopifyAdminError) return data({ error: e.message }, { status: 502 });
    throw e;
  }
  return data({ error: "Unknown action." }, { status: 400 });
}

type LineSummary = { title: string; quantity: number; courseIds: string[] };
function asLines(v: unknown): LineSummary[] {
  if (!Array.isArray(v)) return [];
  return v.map((l: any) => ({
    title: String(l?.title ?? ""),
    quantity: Number(l?.quantity) || 1,
    courseIds: Array.isArray(l?.courseIds) ? l.courseIds.map(String) : [],
  }));
}

const PAYMENT_STYLE: Record<string, string> = {
  paid: "bg-green-100 text-green-800",
  partially_refunded: "bg-amber-100 text-amber-800",
  refunded: "bg-red-100 text-red-700",
  pending: "bg-gray-100 text-gray-700",
  authorized: "bg-gray-100 text-gray-700",
  voided: "bg-red-100 text-red-700",
};

export default function Orders() {
  const { orders, q, filter, page, totalPages, totalCount, canResync } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data as { success?: boolean; message?: string; error?: string } | undefined;

  const link = (params: Record<string, string | number>) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (filter !== "all") sp.set("filter", filter);
    for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
    return `?${sp.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Every Shopify order the LMS has received, matched to its license keys and seats.
          </p>
        </div>
        {canResync && (
          <fetcher.Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="fetch_by_number" />
            <input
              name="name"
              placeholder="Order # from Shopify"
              aria-label="Shopify order number"
              className="w-44 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-navy"
            />
            <button
              type="submit"
              disabled={busy}
              title="Pull an order that never reached the LMS (a lost webhook) and issue its keys"
              className="flex items-center gap-1.5 bg-brand-navy text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-brand-navy-dark disabled:opacity-50"
            >
              <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Fetch from Shopify
            </button>
          </fetcher.Form>
        )}
      </div>

      {!canResync && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
          Re-sync from Shopify is off: set <span className="font-mono">SHOPIFY_STORE_DOMAIN</span> and{" "}
          <span className="font-mono">SHOPIFY_ACCESS_TOKEN</span> (a custom app token with the{" "}
          <span className="font-mono">read_orders</span> scope) to pull orders whose webhook was lost.
        </div>
      )}

      {result && (result.message || result.error) && (
        <div
          className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
            result.success ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {result.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <AlertCircle size={15} className="shrink-0 mt-0.5" />}
          {result.message ?? result.error}
        </div>
      )}

      <div className="bg-white shadow-sm border border-gray-200 rounded-lg">
        <div className="p-4 border-b border-gray-200 flex flex-wrap gap-3 items-center justify-between">
          <Form method="get" className="flex flex-wrap items-center gap-2">
            {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
            <div className="relative w-full sm:w-64">
              <Search size={14} className="absolute left-3 inset-y-0 my-auto text-gray-400" />
              <input
                name="q"
                defaultValue={q}
                aria-label="Search orders"
                placeholder="Order #, email or organization…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-navy"
              />
            </div>
            <button type="submit" className="bg-brand-navy text-white px-4 py-1.5 rounded-md text-sm font-medium hover:bg-brand-navy-dark">
              Search
            </button>
            {q && (
              <Link to={filter !== "all" ? `?filter=${filter}` : "?"} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
                <X size={12} /> Clear
              </Link>
            )}
          </Form>
          <div className="flex items-center gap-1 text-xs">
            {FILTERS.map((f) => (
              <Link
                key={f}
                to={link({ filter: f, page: 1 })}
                className={`px-2.5 py-1 rounded-md font-medium ${filter === f ? "bg-brand-navy text-white" : "text-gray-600 hover:bg-gray-100"}`}
              >
                {f === "all" ? "All" : f === "attention" ? "Needs attention" : f === "cancelled" ? "Cancelled" : "Chargebacks"}
              </Link>
            ))}
            <span className="ml-2 text-gray-400">{totalCount} order{totalCount === 1 ? "" : "s"}</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {["Order", "Customer", "Payment", "Items", "Seats", "Status", "Actions"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-400">
                    <ShoppingBag size={30} className="mx-auto mb-2 opacity-30" />
                    {q || filter !== "all" ? "No orders match." : "No Shopify orders yet."}
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
                  const totalSeats = o.seats.active + o.seats.invited + o.seats.available;
                  return (
                    <tr key={o.orderId} className="align-top hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="font-semibold text-gray-900">{o.orderName ?? `#${o.orderId}`}</p>
                        <p className="text-[11px] text-gray-400">id {o.orderId}</p>
                        <p className="text-[11px] text-gray-400">{new Date(o.processedAt).toLocaleString()}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-800 text-xs break-all">{o.customerEmail ?? "—"}</p>
                        {o.organization && (
                          <Link to={`/organizations?id=${o.organization.id}`} className="text-[11px] text-brand-navy hover:underline">
                            {o.organization.name}
                          </Link>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {o.financialStatus ? (
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${PAYMENT_STYLE[o.financialStatus] ?? "bg-gray-100 text-gray-700"}`}>
                            {o.financialStatus.replace(/_/g, " ")}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                        {o.total && <p className="text-xs text-gray-600 mt-1">{o.total}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-700 min-w-[200px]">
                        {o.lines.length === 0 && <span className="text-gray-400">not recorded</span>}
                        {o.lines.map((l, i) => (
                          <p key={i}>
                            {l.quantity} × {l.title}
                            {l.courses.length > 0 && <span className="text-gray-400"> → {l.courses.join(" + ")}</span>}
                          </p>
                        ))}
                        {o.unmapped.map((u, i) => (
                          <p key={`u${i}`} className="text-amber-700 font-mono text-[11px] break-all mt-0.5">{u}</p>
                        ))}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {totalSeats + o.seats.revoked === 0 ? (
                          <span className="text-gray-400">no keys</span>
                        ) : (
                          <>
                            <p className="text-gray-900 font-medium">{totalSeats} seat{totalSeats === 1 ? "" : "s"}</p>
                            <p className="text-gray-500">
                              {o.seats.active} in use · {o.seats.invited} invited · {o.seats.available} available
                            </p>
                            {o.seats.revoked > 0 && <p className="text-red-600">{o.seats.revoked} revoked</p>}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs space-y-1">
                        {o.cancelled && <span className="block w-fit px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Cancelled</span>}
                        {o.dispute && <span className="block w-fit px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Chargeback {o.dispute.replace(/_/g, " ")}</span>}
                        {o.unmapped.length > 0 && <span className="block w-fit px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">Needs attention</span>}
                        {!o.cancelled && !o.dispute && o.unmapped.length === 0 && <span className="block w-fit px-2 py-0.5 rounded-full bg-green-100 text-green-800 font-medium">OK</span>}
                        {o.lastSyncedAt && <p className="text-[10px] text-gray-400">synced {new Date(o.lastSyncedAt).toLocaleDateString()}</p>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        <div className="flex flex-col gap-1">
                          <Link to={`/licenses?q=${encodeURIComponent(o.orderName ?? o.orderId)}`} className="inline-flex items-center gap-1 text-brand-navy hover:underline">
                            <Key size={12} /> Keys
                          </Link>
                          {o.shopifyUrl && (
                            <a href={o.shopifyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-navy hover:underline">
                              <ExternalLink size={12} /> Open in Shopify
                            </a>
                          )}
                          {canResync && (
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="resync" />
                              <input type="hidden" name="orderId" value={o.orderId} />
                              <button type="submit" disabled={busy} className="inline-flex items-center gap-1 text-brand-navy hover:underline disabled:opacity-50">
                                <RefreshCw size={12} /> Re-sync from Shopify
                              </button>
                            </fetcher.Form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-sm">
            <span className="text-gray-500">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link to={link({ page: page - 1 })} className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50">
                  <ChevronLeft size={14} /> Previous
                </Link>
              )}
              {page < totalPages && (
                <Link to={link({ page: page + 1 })} className="inline-flex items-center gap-1 px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50">
                  Next <ChevronRight size={14} />
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

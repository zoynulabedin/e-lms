import crypto from "crypto";
import { data, Form, Link, useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin, hashPassword, hashToken } from "../utils/auth.server";
import { sendOrgManagerInviteEmail } from "../utils/email.server";
import { AlertCircle, Building2, CheckCircle2, Key, Plus, Search, ShoppingBag, UserPlus, X } from "lucide-react";

/**
 * Organizations (admin): every organization seat pool - created from company /
 * multi-seat Shopify orders, or by hand here - with its seat balance, orders
 * and managers. Managers invite learners themselves at /org.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const focus = url.searchParams.get("id");

  const orgs = await prisma.organization.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { contactEmail: { contains: q, mode: "insensitive" } },
            { managers: { some: { email: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : focus
        ? { id: focus }
        : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      contactEmail: true,
      shopifyCustomerId: true,
      createdAt: true,
      managers: { select: { id: true, name: true, email: true } },
      _count: { select: { orders: true } },
    },
  });
  const ids = orgs.map((o) => o.id);
  const [statusGroups, invitedGroups] = await Promise.all([
    prisma.license.groupBy({ by: ["organizationId", "status"], where: { organizationId: { in: ids } }, _count: { _all: true } }),
    prisma.license.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: ids }, status: "PENDING", assignedEmail: { not: null } },
      _count: { _all: true },
    }),
  ]);
  return {
    q,
    focus,
    orgs: orgs.map((o) => {
      const n = (s: string) => statusGroups.find((g) => g.organizationId === o.id && g.status === s)?._count._all ?? 0;
      const invited = invitedGroups.find((g) => g.organizationId === o.id)?._count._all ?? 0;
      return {
        ...o,
        orderCount: o._count.orders,
        seats: { inUse: n("ACTIVE"), invited, available: n("PENDING") - invited, revoked: n("REVOKED") },
      };
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "create") {
    const name = String(form.get("name") || "").trim().slice(0, 120);
    const contactEmail = String(form.get("contactEmail") || "").trim().toLowerCase() || null;
    if (!name) return data({ error: "Enter the organization's name." }, { status: 400 });
    if (contactEmail && !EMAIL_RE.test(contactEmail)) return data({ error: "Contact email is not valid." }, { status: 400 });
    const org = await prisma.organization.create({ data: { name, contactEmail }, select: { id: true } });
    console.warn(`[organizations] ${admin.email} created organization "${name}"`);
    return data({ success: true, message: `Organization "${name}" created. Add a manager, then add seats with Generate Bulk Keys (choose this organization).`, id: org.id });
  }

  const orgId = String(form.get("orgId") || "");
  const org = orgId ? await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } }) : null;
  if (!org) return data({ error: "Organization not found." }, { status: 404 });

  if (intent === "add_manager") {
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return data({ error: "Enter a valid email address." }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, organizationId: true } });
    let setPasswordToken: string | null = null;
    if (user) {
      if (user.organizationId && user.organizationId !== org.id) {
        return data({ error: `${email} already manages another organization. Remove them there first.` }, { status: 409 });
      }
      await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id } });
    } else {
      // A new manager account, opened with a 7-day set-password link.
      const created = await prisma.user.create({
        data: {
          email,
          name: email,
          role: "CORPORATE",
          organizationId: org.id,
          passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")),
        },
        select: { id: true },
      });
      setPasswordToken = crypto.randomBytes(32).toString("hex");
      await prisma.passwordReset.create({
        data: { userId: created.id, token: hashToken(setPasswordToken), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      });
    }
    const sent = await sendOrgManagerInviteEmail({ to: email, orgName: org.name, setPasswordToken });
    console.warn(`[organizations] ${admin.email} made ${email} a manager of "${org.name}"`);
    return data({
      success: true,
      message: `${email} now manages "${org.name}".` + (sent.ok ? " They were emailed." : ` The email could not be sent (${sent.error}).`),
    });
  }

  if (intent === "remove_manager") {
    const userId = String(form.get("userId") || "");
    const r = await prisma.user.updateMany({ where: { id: userId, organizationId: org.id }, data: { organizationId: null } });
    if (r.count === 0) return data({ error: "That person is not a manager here." }, { status: 404 });
    console.warn(`[organizations] ${admin.email} removed a manager (${userId}) from "${org.name}"`);
    return data({ success: true, message: "Manager removed. Their own courses are not affected." });
  }

  if (intent === "rename") {
    const name = String(form.get("name") || "").trim().slice(0, 120);
    if (!name) return data({ error: "Enter a name." }, { status: 400 });
    await prisma.organization.update({ where: { id: org.id }, data: { name } });
    return data({ success: true, message: `Renamed to "${name}".` });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Organizations() {
  const { orgs, q, focus } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data as { success?: boolean; message?: string; error?: string } | undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Organizations</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Seat pools from company or multi-seat orders. Managers invite learners at <span className="font-mono">/org</span>.
          </p>
        </div>
        <fetcher.Form method="post" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="create" />
          <input name="name" required placeholder="New organization name" className="w-48 px-3 py-1.5 text-sm border border-gray-300 rounded-md" />
          <input name="contactEmail" type="email" placeholder="Contact email (optional)" className="w-52 px-3 py-1.5 text-sm border border-gray-300 rounded-md" />
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 bg-brand-navy text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-brand-navy-dark disabled:opacity-50">
            <Plus size={14} /> Create
          </button>
        </fetcher.Form>
      </div>

      {result && (result.message || result.error) && (
        <div className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${result.success ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
          {result.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <AlertCircle size={15} className="shrink-0 mt-0.5" />}
          {result.message ?? result.error}
        </div>
      )}

      <Form method="get" className="flex items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 inset-y-0 my-auto text-gray-400" />
          <input name="q" defaultValue={q} placeholder="Name, contact or manager email…" aria-label="Search organizations" className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white" />
        </div>
        <button type="submit" className="bg-brand-navy text-white px-4 py-1.5 rounded-md text-sm font-medium">Search</button>
        {(q || focus) && (
          <Link to="/organizations" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
            <X size={12} /> Show all
          </Link>
        )}
      </Form>

      {orgs.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-gray-400">
          <Building2 size={30} className="mx-auto mb-2 opacity-30" />
          {q ? "No organizations match." : "No organizations yet. They appear when a company or multi-seat order is paid."}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {orgs.map((o) => {
            const total = o.seats.inUse + o.seats.invited + o.seats.available;
            return (
              <div key={o.id} className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold text-gray-900 truncate">{o.name}</h2>
                    <p className="text-xs text-gray-500">
                      {o.contactEmail ?? "no contact email"}
                      {o.shopifyCustomerId ? ` · Shopify customer ${o.shopifyCustomerId}` : ""} · since {new Date(o.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-xs shrink-0">
                    <Link to={`/licenses?q=${encodeURIComponent(o.name)}`} className="inline-flex items-center gap-1 text-brand-navy hover:underline"><Key size={12} /> Keys</Link>
                    <Link to={`/orders?q=${encodeURIComponent(o.name)}`} className="inline-flex items-center gap-1 text-brand-navy hover:underline"><ShoppingBag size={12} /> {o.orderCount} order{o.orderCount === 1 ? "" : "s"}</Link>
                  </div>
                </div>
                <div className="text-sm">
                  <p className="text-gray-900 font-medium">{total} seat{total === 1 ? "" : "s"}</p>
                  <p className="text-xs text-gray-500">
                    {o.seats.inUse} in use · {o.seats.invited} invited · {o.seats.available} available
                    {o.seats.revoked ? ` · ${o.seats.revoked} revoked` : ""}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Managers</p>
                  {o.managers.length === 0 && <p className="text-xs text-amber-700">No manager yet - add one so the seats can be assigned.</p>}
                  <ul className="space-y-1">
                    {o.managers.map((m) => (
                      <li key={m.id} className="flex items-center justify-between text-sm">
                        <span className="text-gray-800 truncate">{m.email}</span>
                        <fetcher.Form method="post" onSubmit={(e) => { if (!confirm(`Remove ${m.email} as a manager of ${o.name}?`)) e.preventDefault(); }}>
                          <input type="hidden" name="intent" value="remove_manager" />
                          <input type="hidden" name="orgId" value={o.id} />
                          <input type="hidden" name="userId" value={m.id} />
                          <button type="submit" className="text-xs text-red-600 hover:underline">Remove</button>
                        </fetcher.Form>
                      </li>
                    ))}
                  </ul>
                  <fetcher.Form method="post" className="mt-2 flex items-center gap-2">
                    <input type="hidden" name="intent" value="add_manager" />
                    <input type="hidden" name="orgId" value={o.id} />
                    <input name="email" type="email" required placeholder="manager@company.com" className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-md" />
                    <button type="submit" disabled={busy} className="inline-flex items-center gap-1 border border-gray-300 text-gray-700 px-3 py-1.5 rounded-md text-xs font-medium hover:bg-gray-50 disabled:opacity-50">
                      <UserPlus size={13} /> Add manager
                    </button>
                  </fetcher.Form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

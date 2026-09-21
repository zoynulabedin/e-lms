import { useLoaderData, Form, useFetcher } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { generateLicenseKey } from "../utils/auth.server";
import { sendLicenseEmail } from "../utils/email.server";
import { PLACEHOLDER_EMAIL, isPlaceholderEmail } from "../utils/license";
import { useState, useEffect } from "react";
import {
  Plus,
  MoreVertical,
  X,
  Filter,
  CheckCircle2,
  Clock,
  Ban,
  Key,
  AlertCircle,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Mail,
  Loader2,
  Trash2,
  ShoppingBag,
} from "lucide-react";

const PER_PAGE = 20;

/**
 * A key that has never reached ANYONE.
 *
 * "Not redeemed" is not enough on its own: a customer who buys on Friday and
 * redeems on Monday holds a paid, emailed key that is still PENDING with no
 * user attached, and it must survive the clean-up. So this also requires that
 * the key never came from an order (`shopifyOrderId: null`) and was never
 * addressed to a real person (`customerEmail` is still the bulk placeholder).
 * What is left is pure over-generation, which loses nothing but the key.
 *
 * Used as the `where` fragment for BOTH the count the admin is shown and the
 * delete that follows, so the number and the rows can never disagree.
 */
const NO_BUYER = [
  { customerEmail: PLACEHOLDER_EMAIL },
  { customerEmail: "pending@customer.com" },
  { customerEmail: { endsWith: "@placeholder.com" } },
];

const NEVER_ISSUED = {
  userId: null,
  redeemedAt: null,
  status: "PENDING",
  shopifyOrderId: null,
  // The SQL mirror of isPlaceholderEmail() in utils/license.ts.
  OR: NO_BUYER,
} as const;

/** Counted alongside, so the clean-up dialog can say what it is leaving behind. */
const ISSUED_BUT_UNREDEEMED = {
  userId: null,
  redeemedAt: null,
  status: "PENDING",
  NOT: { shopifyOrderId: null, OR: NO_BUYER },
} as const;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const VALID_STATUS = ["ALL", "ACTIVE", "PENDING", "REVOKED"] as const;
  type StatusFilter = (typeof VALID_STATUS)[number];
  const rawStatus = url.searchParams.get("status") || "ALL";
  const statusFilter: StatusFilter = (VALID_STATUS as readonly string[]).includes(rawStatus)
    ? (rawStatus as StatusFilter)
    : "ALL";
  const rawPage = parseInt(url.searchParams.get("page") || "1", 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const where = statusFilter !== "ALL" ? { status: statusFilter } : undefined;

  // Counted first so the requested page can be clamped: deleting the last row
  // of the last page would otherwise leave the admin staring at an empty table.
  const totalCount = await prisma.license.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
  const page = Math.min(requestedPage, totalPages);

  const [licenses, courses, unusedGroups, keptGroups] = await Promise.all([
    prisma.license.findMany({
      where,
      include: {
        course: { select: { id: true, title: true } },
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      take: PER_PAGE,
      skip: (page - 1) * PER_PAGE,
    }),
    prisma.course.findMany({
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
    // How many keys per course have never been handed to anyone. These are the
    // only ones the bulk clean-up will touch.
    prisma.license.groupBy({
      by: ["courseId"],
      where: NEVER_ISSUED,
      _count: { _all: true },
    }),
    prisma.license.groupBy({
      by: ["courseId"],
      where: ISSUED_BUT_UNREDEEMED,
      _count: { _all: true },
    }),
  ]);

  const unusedByCourse: Record<string, number> = {};
  for (const g of unusedGroups) unusedByCourse[g.courseId] = g._count._all;
  const keptByCourse: Record<string, number> = {};
  for (const g of keptGroups) keptByCourse[g.courseId] = g._count._all;

  return {
    licenses, courses, statusFilter, page, totalPages, totalCount,
    unusedByCourse, keptByCourse,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resend_email") {
    const id = formData.get("id") as string;
    if (!id) return data({ error: "Missing license ID" }, { status: 400 });

    const license = await prisma.license.findUnique({
      where: { id },
      include: { course: true },
    });
    if (!license) return data({ error: "License not found" }, { status: 404 });
    if (license.status === "REVOKED") {
      return data({ error: "This license is revoked - cannot resend an activation email." }, { status: 400 });
    }
    if (isPlaceholderEmail(license.customerEmail)) {
      return data({ error: "No valid customer email on this license." }, { status: 400 });
    }

    const sent = await sendLicenseEmail({
      to: license.customerEmail,
      licenseKey: license.key,
      courseTitle: license.course?.title ?? "Your Course",
    });
    if (!sent.ok) {
      return data({ error: `Email could not be sent: ${sent.error}` }, { status: 502 });
    }

    return data({ success: true, message: `Email resent to ${license.customerEmail}.` });
  }

  if (intent === "revoke") {
    const id = formData.get("id") as string;
    if (!id) return data({ error: "Missing license ID" }, { status: 400 });
    // updateMany never throws on a missing row (unlike update → P2025 → 500).
    // Access is enforced from license status (see utils/access.server.ts), so
    // the student loses the course immediately — no enrollment cleanup needed.
    const r = await prisma.license.updateMany({
      where: { id, status: { not: "REVOKED" } },
      data: { status: "REVOKED" },
    });
    if (r.count === 0)
      return data({ error: "License not found or already revoked." }, { status: 404 });
    return data({ success: true, message: "License revoked — student access removed." });
  }

  if (intent === "delete_license") {
    const id = formData.get("id") as string;
    if (!id) return data({ error: "Missing license ID" }, { status: 400 });

    const license = await prisma.license.findUnique({
      where: { id },
      select: {
        key: true,
        status: true,
        userId: true,
        redeemedAt: true,
        shopifyOrderId: true,
        customerEmail: true,
        course: { select: { title: true } },
        user: { select: { email: true } },
      },
    });
    if (!license) return data({ error: "License not found." }, { status: 404 });

    const inUse = !!license.userId || !!license.redeemedAt;

    // A licence someone actually holds is not something to lose to a stray
    // click, so the UI has to send an explicit acknowledgement. Revoking keeps
    // the record and removes access just as effectively; deleting is for
    // clearing out keys that should never have existed.
    if (inUse && formData.get("confirm") !== "DELETE") {
      return data(
        {
          error:
            "This key has already been redeemed. Deleting it needs the typed confirmation, " +
            "or use Revoke Access to remove the course without destroying the record.",
        },
        { status: 400 },
      );
    }

    // Guarded delete rather than delete-by-id: if the licence was redeemed
    // between the read above and this write, the row no longer matches and
    // nothing is destroyed. deleteMany also never throws on a missing row.
    //
    // The unused guard deliberately does NOT pin the status. A bulk key whose
    // holder's account was deleted comes back as REVOKED with userId null
    // (see users.tsx), and pinning PENDING made those impossible to clear.
    const { deleted, claimReleased } = await prisma.$transaction(async (tx) => {
      const r = await tx.license.deleteMany({
        where: inUse ? { id } : { id, userId: null, redeemedAt: null },
      });
      if (r.count === 0 || !license.shopifyOrderId) {
        return { deleted: r.count, claimReleased: false };
      }

      // The order id stays claimed in ShopifyOrder, and the webhook skips any
      // order it has already seen - so without this, deleting a Shopify key
      // makes that order permanently un-mintable. Release the claim only once
      // NO keys from the order remain, or a replay would duplicate the ones
      // that are still here.
      const left = await tx.license.count({
        where: { shopifyOrderId: license.shopifyOrderId },
      });
      if (left > 0) return { deleted: r.count, claimReleased: false };

      await tx.shopifyOrder.deleteMany({ where: { orderId: license.shopifyOrderId } });
      return { deleted: r.count, claimReleased: true };
    });

    if (deleted === 0) {
      return data(
        { error: "License not deleted — it was redeemed while you were looking at it." },
        { status: 409 },
      );
    }

    // There is no audit table in this app; a log line is the minimum record of
    // who destroyed what.
    console.warn(
      `[licenses] ${admin.email} deleted key ${license.key} ` +
        `(${license.status}, course "${license.course?.title ?? "?"}"` +
        (license.userId ? `, held by ${license.user?.email ?? license.customerEmail}` : ", unredeemed") +
        (license.shopifyOrderId ? `, Shopify order ${license.shopifyOrderId}` : "") +
        (claimReleased ? ", order claim released" : "") +
        ")",
    );

    return data({
      success: true,
      message:
        (inUse
          ? "License deleted — the student has lost access to that course."
          : "License key deleted.") +
        (claimReleased
          ? " That Shopify order is no longer marked as processed, so re-sending its webhook will issue a fresh key."
          : ""),
    });
  }

  if (intent === "delete_unused") {
    const courseId = (formData.get("courseId") as string)?.trim();
    if (!courseId) return data({ error: "Please select a course." }, { status: 400 });

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { title: true },
    });
    if (!course) return data({ error: "Selected course does not exist." }, { status: 400 });

    // Scoped to NEVER_ISSUED, so anything redeemed, sold or emailed since the
    // admin opened the dialog is simply not in the set and survives.
    const r = await prisma.license.deleteMany({ where: { courseId, ...NEVER_ISSUED } });

    if (r.count === 0) {
      return data(
        { error: `No never-issued keys left for "${course.title}".` },
        { status: 404 },
      );
    }

    console.warn(
      `[licenses] ${admin.email} deleted ${r.count} unused key(s) for course "${course.title}"`,
    );

    return data({
      success: true,
      message: `${r.count} never-issued key${r.count > 1 ? "s" : ""} deleted for "${course.title}".`,
    });
  }

  if (intent === "generate_bulk") {
    const rawCount = formData.get("count") as string;
    const courseId = (formData.get("courseId") as string)?.trim();
    const customerEmail = ((formData.get("customerEmail") as string) || "")
      .trim()
      .toLowerCase();
    const count = parseInt(rawCount, 10);

    if (!count || isNaN(count) || count < 1 || count > 200) {
      return data(
        { error: "Count must be between 1 and 200." },
        { status: 400 },
      );
    }

    if (!courseId) {
      return data({ error: "Please select a course." }, { status: 400 });
    }
    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      return data(
        { error: "Selected course does not exist." },
        { status: 400 },
      );
    }

    await prisma.$transaction(
      Array.from({ length: count }).map(() =>
        prisma.license.create({
          data: {
            key: generateLicenseKey(),
            courseId,
            customerEmail: customerEmail || PLACEHOLDER_EMAIL,
            status: "PENDING",
            isBulk: true,
          },
        }),
      ),
    );

    return data({
      success: true,
      message: `${count} license key${count > 1 ? "s" : ""} generated for "${course.title}".`,
    });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ── Delete a single licence ─────────────────────────────────────────

function DeleteLicenseDialog({
  license,
  onClose,
  onDone,
}: {
  license: any;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Its own fetcher, not the page's. The page-level one is shared by every
  // revoke form and the bulk-generate modal, so a previous result would still
  // be sitting in fetcher.data when this dialog mounts - and the success
  // effect below would close it before the admin had done anything.
  const fetcher = useFetcher<any>();
  const inUse = !!license.userId || !!license.redeemedAt;
  const fromShopify = !!license.shopifyOrderId;
  const [typed, setTyped] = useState("");
  const busy = fetcher.state !== "idle";

  // Close once the delete has gone through. An error keeps the dialog open so
  // the message is read where it was caused.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      onDone(fetcher.data.message ?? "License deleted.");
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Trash2 size={16} className="text-red-600" /> Delete license key
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm">
            <p className="font-mono font-semibold text-gray-900 break-all">{license.key}</p>
            <p className="text-gray-600 mt-1">{license.course?.title ?? "Unknown course"}</p>
            <p className="text-gray-500 text-xs mt-1">
              {inUse
                ? `Held by ${license.user?.email ?? license.customerEmail}`
                : "Never redeemed"}
              {" \u00b7 "}
              {license.status}
            </p>
          </div>

          {fetcher.data?.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 text-sm flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 mt-0.5" /> {fetcher.data.error}
            </div>
          )}

          {inUse ? (
            <>
              <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm space-y-2">
                <p className="font-semibold">This key has been redeemed.</p>
                <ul className="list-disc pl-5 space-y-1 text-[13px]">
                  <li>The student loses access to this course immediately.</li>
                  <li>The key itself is gone and cannot be re-created.</li>
                  <li>
                    This row is also the record of the sale. Revenue on the
                    dashboard and the license export both drop accordingly.
                  </li>
                  <li>
                    Their progress is kept, and a certificate they have already
                    earned stays valid.
                  </li>
                  <li>
                    Quiz attempts are kept too, so a replacement key will not
                    give them fresh attempts.
                  </li>
                </ul>
                <p className="text-[13px]">
                  <a href="/reports/export" className="underline font-medium">
                    Export the license list
                  </a>{" "}
                  first if you need a record of it.
                </p>
              </div>

              {fromShopify && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm flex items-start gap-2">
                  <ShoppingBag size={14} className="shrink-0 mt-0.5" />
                  <span>
                    This key came from Shopify order{" "}
                    <strong>{license.shopifyOrderId}</strong>. Deleting it also
                    releases that order, so re-sending its webhook from Shopify
                    will issue a fresh key \u2014 a different key string, which the
                    customer would need to be sent.
                  </span>
                </div>
              )}

              <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 text-sm">
                <strong>Revoke Access</strong> removes the course just as
                effectively and keeps the record of the sale. Delete is for keys
                that should never have existed.
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Type <span className="font-mono font-semibold">DELETE</span> to confirm
                </label>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-red-500"
                  placeholder="DELETE"
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-600">
              Nobody has used this key, so nothing is lost but the key itself.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (inUse && typed !== "DELETE")}
            onClick={() =>
              fetcher.submit(
                { intent: "delete_license", id: license.id, confirm: inUse ? typed : "" },
                { method: "post" },
              )
            }
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete key
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk clean-up of keys nobody ever received ──────────────────────────

function CleanupDialog({
  courses,
  unusedByCourse,
  keptByCourse,
  onClose,
  onDone,
}: {
  courses: Array<{ id: string; title: string }>;
  unusedByCourse: Record<string, number>;
  keptByCourse: Record<string, number>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  // Own fetcher, for the same reason as the delete dialog.
  const fetcher = useFetcher<any>();
  const [courseId, setCourseId] = useState("");
  const count = courseId ? (unusedByCourse[courseId] ?? 0) : 0;
  const kept = courseId ? (keptByCourse[courseId] ?? 0) : 0;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      onDone(fetcher.data.message ?? "Keys deleted.");
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Trash2 size={16} className="text-red-600" /> Delete unused keys
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600">
            Clears out keys that were generated here and never went anywhere \u2014
            the usual tidy-up after generating a batch for the wrong course.
          </p>
          <p className="text-xs text-gray-500">
            Anything redeemed, revoked, bought through Shopify or emailed to a
            named customer is left alone, even if it has not been redeemed yet.
          </p>

          {fetcher.data?.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 text-sm flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 mt-0.5" /> {fetcher.data.error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Course</label>
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg py-2 pl-3 pr-8 text-sm focus:border-brand-navy focus:ring-brand-navy"
            >
              <option value="">Select a course\u2026</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({unusedByCourse[c.id] ?? 0} never issued)
                </option>
              ))}
            </select>
          </div>

          {courseId && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm space-y-1">
              <p className={count > 0 ? "text-gray-900 font-medium" : "text-gray-500"}>
                {count > 0
                  ? `${count} never-issued key${count > 1 ? "s" : ""} will be deleted.`
                  : "No never-issued keys for this course."}
              </p>
              {kept > 0 && (
                <p className="text-gray-600 text-[13px]">
                  {kept} other unredeemed key{kept > 1 ? "s" : ""} already went to a
                  customer and {kept > 1 ? "are" : "is"} being kept.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !courseId || count === 0}
            onClick={() =>
              fetcher.submit({ intent: "delete_unused", courseId }, { method: "post" })
            }
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete {count > 0 ? count : ""} key{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  REVOKED: "bg-red-100 text-red-800",
};
const StatusIcon = ({ status }: { status: string }) => {
  if (status === "ACTIVE") return <CheckCircle2 size={12} />;
  if (status === "PENDING") return <Clock size={12} />;
  return <Ban size={12} />;
};

/** Copy text to clipboard; falls back to execCommand on non-secure (http) origins. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

/** Key chip shown in the table — click the chip or the icon to copy. */
function InlineCopyKey({ licenseKey }: { licenseKey: string }) {
  const { copied, copy } = useCopy(licenseKey);
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied!" : "Click to copy"}
      className="group/key inline-flex items-center gap-1.5 font-mono text-xs bg-gray-100 hover:bg-gray-200 text-slate-800 pl-2 pr-1.5 py-0.5 rounded transition-colors cursor-pointer"
    >
      <span className="select-all">{licenseKey}</span>
      {copied ? (
        <Check size={12} className="text-green-600 shrink-0" />
      ) : (
        <Copy
          size={12}
          className="text-gray-400 group-hover/key:text-gray-700 shrink-0"
        />
      )}
    </button>
  );
}

/** Dropdown-menu variant. */
function CopyKeyButton({ licenseKey }: { licenseKey: string }) {
  const { copied, copy } = useCopy(licenseKey);
  return (
    <button
      onClick={copy}
      className="flex w-full items-center gap-2 px-4 py-2 text-xs text-left text-gray-700 hover:bg-gray-50 cursor-pointer"
    >
      {copied ? (
        <>
          <Check size={11} className="text-green-500" />
          <span className="text-green-600">Copied!</span>
        </>
      ) : (
        <>
          <Copy size={11} />
          Copy Key
        </>
      )}
    </button>
  );
}

function ResendEmailButton({ licenseId }: { licenseId: string }) {
  const fetcher = useFetcher<typeof action>();
  const isSending = fetcher.state === "submitting";
  const sent = fetcher.data && "success" in fetcher.data && fetcher.data.success;

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="resend_email" />
      <input type="hidden" name="id" value={licenseId} />
      <button
        type="submit"
        disabled={isSending}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs text-left text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {isSending ? (
          <><Loader2 size={11} className="animate-spin" /> Sending…</>
        ) : sent ? (
          <><Check size={11} className="text-green-500" /><span className="text-green-600">Sent!</span></>
        ) : (
          <><Mail size={11} /> Resend Email</>
        )}
      </button>
    </fetcher.Form>
  );
}

export default function LicenseManagement() {
  const {
    licenses, courses, statusFilter, page, totalPages, totalCount,
    unusedByCourse, keptByCourse,
  } = useLoaderData<typeof loader>();
  const [isModalOpen, setIsModalOpen] = useState(false);
  /** The licence the admin is about to delete, or null when the dialog is shut. */
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  /** Set by a dialog once its delete succeeded, so the page can confirm it
   *  after the dialog has closed. */
  const [notice, setNotice] = useState<string | null>(null);
  const fetcher = useFetcher<typeof action>();

  const isSubmitting = fetcher.state === "submitting";
  const actionResult = fetcher.data;

  const modalSuccess =
    actionResult && "success" in actionResult && actionResult.success;

  const pageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    params.set("page", String(p));
    return `?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">
          License Management
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCleanupOpen(true)}
            title="Delete keys that were generated but never redeemed"
            className="flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-2 rounded-md font-medium text-sm hover:bg-gray-50 transition-colors"
          >
            <Trash2 size={16} /> Delete Unused Keys
          </button>
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 bg-brand-navy text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-brand-navy-dark transition-colors shadow-sm"
          >
            <Plus size={16} /> Generate Bulk Keys
          </button>
        </div>
      </div>

      {notice && (
        <div className="rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-2.5 text-sm flex items-start gap-2">
          <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-green-700/60 hover:text-green-900"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Action feedback banner */}
      {actionResult &&
        "message" in actionResult &&
        actionResult.message &&
        !isModalOpen && (
          <div
            className={`rounded-lg px-4 py-3 text-sm flex items-center gap-2 ${
              "success" in actionResult && actionResult.success
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {"success" in actionResult && actionResult.success ? (
              <CheckCircle2 size={15} />
            ) : (
              <AlertCircle size={15} />
            )}
            {actionResult.message}
          </div>
        )}

      {/* Filter & Table */}
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg">
        <div className="p-4 border-b border-gray-200 flex flex-wrap gap-4 items-center justify-between">
          <Form method="get" className="flex items-center gap-2">
            <Filter size={15} className="text-gray-500" />
            <select
              name="status"
              defaultValue={statusFilter}
              onChange={(e) => e.target.form?.submit()}
              className="text-sm border-gray-300 rounded-md shadow-sm focus:border-brand-navy focus:ring-brand-navy py-1.5 pl-3 pr-8"
            >
              <option value="ALL">All Status</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="REVOKED">Revoked</option>
            </select>
          </Form>
          <span className="text-xs text-gray-400">
            {totalCount} record{totalCount !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {[
                  "License Key",
                  "Course",
                  "Customer / User",
                  "Status",
                  "Created",
                  "Actions",
                ].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-6 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200 text-sm">
              {licenses.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <Key size={32} className="opacity-30" />
                      <p className="font-medium text-gray-500">
                        No licenses found
                      </p>
                      <p className="text-xs">
                        Generate bulk keys above or connect Shopify to
                        auto-create.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                licenses.map((license: any) => (
                  <tr key={license.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3 whitespace-nowrap">
                      <InlineCopyKey licenseKey={license.key} />
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap text-gray-700 max-w-[180px] truncate">
                      {license.course?.title ?? (
                        <span className="text-red-500 text-xs italic">
                          Missing course
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <p className="text-gray-900 text-xs font-medium truncate max-w-[160px]">
                          {license.user?.name || "—"}
                        </p>
                        {license.user?.role && (
                          <span
                            className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold uppercase shrink-0 ${
                              license.user.role === "ADMIN"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-blue-100 text-blue-700"
                            }`}
                          >
                            {license.user.role === "ADMIN" ? "Admin" : "Student"}
                          </span>
                        )}
                      </div>
                      <p className="text-gray-400 text-xs truncate max-w-[180px]">
                        {license.customerEmail}
                      </p>
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${statusStyles[license.status] ?? "bg-gray-100 text-gray-800"}`}
                      >
                        <StatusIcon status={license.status} /> {license.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap text-gray-500 text-xs">
                      {new Date(license.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 whitespace-nowrap text-right text-sm font-medium">
                      <div className="relative inline-block text-left group">
                        <button className="text-gray-400 hover:text-gray-600 p-1.5 rounded hover:bg-gray-100 transition-colors">
                          <MoreVertical size={15} />
                        </button>
                        <div className="hidden group-hover:block absolute right-0 z-50 w-44 mt-1 origin-top-right bg-white border border-gray-200 divide-y divide-gray-100 rounded-lg shadow-lg">
                          <div className="py-1">
                            <ResendEmailButton licenseId={license.id} />
                            <CopyKeyButton licenseKey={license.key} />
                          </div>
                          {license.status !== "REVOKED" && (
                            <div className="py-1">
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="revoke"
                                />
                                <input
                                  type="hidden"
                                  name="id"
                                  value={license.id}
                                />
                                <button
                                  type="submit"
                                  className="block w-full px-4 py-2 text-xs text-left text-red-600 hover:bg-red-50"
                                  onClick={(e) => {
                                    if (!confirm("Revoke this license?"))
                                      e.preventDefault();
                                  }}
                                >
                                  Revoke Access
                                </button>
                              </fetcher.Form>
                            </div>
                          )}
                          <div className="py-1">
                            <button
                              type="button"
                              onClick={() => setPendingDelete(license)}
                              className="flex w-full items-center gap-2 px-4 py-2 text-xs text-left text-red-600 hover:bg-red-50"
                            >
                              <Trash2 size={12} /> Delete Key
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
            <span className="text-xs text-gray-500">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <a
                href={pageUrl(page - 1)}
                aria-disabled={page <= 1}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  page <= 1
                    ? "border-gray-200 text-gray-300 cursor-not-allowed pointer-events-none"
                    : "border-gray-300 text-gray-700 hover:bg-white"
                }`}
              >
                <ChevronLeft size={13} /> Prev
              </a>
              <a
                href={pageUrl(page + 1)}
                aria-disabled={page >= totalPages}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                  page >= totalPages
                    ? "border-gray-200 text-gray-300 cursor-not-allowed pointer-events-none"
                    : "border-gray-300 text-gray-700 hover:bg-white"
                }`}
              >
                Next <ChevronRight size={13} />
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation. A dialog rather than window.confirm because the
          consequences depend on who holds the key, and the admin has to be able
          to see that before deciding. */}
      {pendingDelete && (
        <DeleteLicenseDialog
          license={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDone={setNotice}
        />
      )}

      {/* Bulk clean-up of keys nobody ever received */}
      {cleanupOpen && (
        <CleanupDialog
          courses={courses}
          unusedByCourse={unusedByCourse}
          keptByCourse={keptByCourse}
          onClose={() => setCleanupOpen(false)}
          onDone={setNotice}
        />
      )}

      {/* Bulk Generate Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Key size={16} className="text-brand-navy" /> Generate Bulk
                License Keys
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {actionResult && "error" in actionResult && actionResult.error && (
              <div className="mx-6 mt-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 text-sm flex items-center gap-2">
                <AlertCircle size={14} /> {actionResult.error}
              </div>
            )}

            <fetcher.Form method="post" className="p-6 space-y-4">
              <input type="hidden" name="intent" value="generate_bulk" />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Course <span className="text-red-500">*</span>
                </label>
                {courses.length === 0 ? (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 text-sm">
                    No courses exist yet. Please{" "}
                    <a href="/courses" className="underline font-medium">
                      add a course
                    </a>{" "}
                    before generating license keys.
                  </div>
                ) : (
                  <select
                    name="courseId"
                    required
                    defaultValue=""
                    className="w-full border border-gray-300 rounded-lg shadow-sm focus:border-brand-navy focus:ring-brand-navy py-2 pl-3 pr-8 text-sm"
                  >
                    <option value="" disabled>
                      Select a course…
                    </option>
                    {courses.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Customer Email{" "}
                  <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="email"
                  name="customerEmail"
                  placeholder="customer@example.com"
                  className="w-full border border-gray-300 rounded-lg shadow-sm focus:border-brand-navy focus:ring-brand-navy py-2 px-3 text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Leave blank for unassigned bulk keys.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Number of Keys <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  name="count"
                  defaultValue={10}
                  min={1}
                  max={200}
                  required
                  className="w-full border border-gray-300 rounded-lg shadow-sm focus:border-brand-navy focus:ring-brand-navy py-2 px-3 text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Min 1, max 200 keys per batch.
                </p>
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || courses.length === 0}
                  className="px-4 py-2 text-sm font-medium text-white bg-brand-navy rounded-lg hover:bg-brand-navy-dark transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? "Generating…" : "Generate Keys"}
                </button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}

      {/* Auto-close modal on success */}
      {modalSuccess && isModalOpen && (
        <span
          ref={(el) => {
            if (el) setTimeout(() => setIsModalOpen(false), 300);
          }}
        />
      )}
    </div>
  );
}

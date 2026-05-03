import { useLoaderData, Form, useFetcher } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { generateLicenseKey } from "../utils/auth.server";
import { sendLicenseEmail } from "../utils/email.server";
import { useState } from "react";
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
} from "lucide-react";

const PER_PAGE = 20;

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") || "ALL";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  const where = statusFilter !== "ALL" ? { status: statusFilter as any } : undefined;

  const [licenses, totalCount, courses] = await Promise.all([
    prisma.license.findMany({
      where,
      include: { course: true, user: true },
      orderBy: { createdAt: "desc" },
      take: PER_PAGE,
      skip: (page - 1) * PER_PAGE,
    }),
    prisma.license.count({ where }),
    prisma.course.findMany({
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));

  return { licenses, courses, statusFilter, page, totalPages, totalCount };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);

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
    if (!license.customerEmail || license.customerEmail.includes("placeholder")) {
      return data({ error: "No valid customer email on this license." }, { status: 400 });
    }

    await sendLicenseEmail({
      to: license.customerEmail,
      licenseKey: license.key,
      courseTitle: license.course?.title ?? "Your Course",
    });

    return data({ success: true, message: `Email resent to ${license.customerEmail}.` });
  }

  if (intent === "revoke") {
    const id = formData.get("id") as string;
    if (!id) return data({ error: "Missing license ID" }, { status: 400 });
    await prisma.license.update({ where: { id }, data: { status: "REVOKED" } });
    return data({ success: true, message: "License revoked successfully." });
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
            customerEmail: customerEmail || "unassigned@placeholder.com",
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

function CopyKeyButton({ licenseKey }: { licenseKey: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(licenseKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="flex w-full items-center gap-2 px-4 py-2 text-xs text-left text-gray-700 hover:bg-gray-50"
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
  const { licenses, courses, statusFilter, page, totalPages, totalCount } =
    useLoaderData<typeof loader>();
  const [isModalOpen, setIsModalOpen] = useState(false);
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
        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-brand-navy text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-brand-navy-dark transition-colors shadow-sm"
        >
          <Plus size={16} /> Generate Bulk Keys
        </button>
      </div>

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
                      <code className="font-mono text-xs bg-gray-100 text-slate-800 px-2 py-0.5 rounded">
                        {license.key}
                      </code>
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

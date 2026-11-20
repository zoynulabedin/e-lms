import { data, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser, generateLicenseKey } from "../utils/auth.server";
import { sendSeatInvitationEmail } from "../utils/email.server";
import { rateLimitResponse, recordAttempt } from "../utils/rate-limit.server";
import { ArrowLeft, Building2, CheckCircle2, AlertCircle, Mail, UserMinus, Users, RotateCcw, X } from "lucide-react";

/**
 * Organization manager portal: the seats an organization bought (bulk / company
 * orders, or keys an admin added), who holds them, and invitations.
 *
 * A seat is a licence key in the organization's pool:
 *   in use     ACTIVE (a learner redeemed it)
 *   invited    PENDING with assignedEmail (only that email can redeem it)
 *   available  PENDING, unassigned
 * Every action re-checks that the key belongs to the manager's organization.
 */

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.org ? `${data.org.name} · Seats` : "Organization seats" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITES = 50;

async function managedOrg(userId: string) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { organization: { select: { id: true, name: true } } },
  });
  return me?.organization ?? null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const org = await managedOrg(user.id);
  if (!org) return { org: null, courses: [], seats: [], user: { name: user.name } };

  const keys = await prisma.license.findMany({
    where: { organizationId: org.id },
    select: {
      id: true,
      status: true,
      assignedEmail: true,
      invitedAt: true,
      redeemedAt: true,
      course: { select: { id: true, title: true } },
      user: { select: { name: true, email: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const byCourse = new Map<string, { id: string; title: string; total: number; inUse: number; invited: number; available: number; revoked: number }>();
  for (const k of keys) {
    const c = byCourse.get(k.course.id) ?? { id: k.course.id, title: k.course.title, total: 0, inUse: 0, invited: 0, available: 0, revoked: 0 };
    if (k.status === "REVOKED") c.revoked++;
    else {
      c.total++;
      if (k.status === "ACTIVE") c.inUse++;
      else if (k.assignedEmail) c.invited++;
      else c.available++;
    }
    byCourse.set(k.course.id, c);
  }

  const seats = keys
    .filter((k) => k.status === "ACTIVE" || (k.status === "PENDING" && k.assignedEmail))
    .map((k) => ({
      id: k.id,
      course: k.course.title,
      state: k.status === "ACTIVE" ? ("in use" as const) : ("invited" as const),
      name: k.user?.name ?? null,
      email: k.user?.email ?? k.assignedEmail ?? "",
      since: k.status === "ACTIVE" ? k.redeemedAt : k.invitedAt,
    }));

  return { org, courses: Array.from(byCourse.values()), seats, user: { name: user.name } };
}

type ActionResult = { ok?: string; error?: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const org = await managedOrg(user.id);
  if (!org) return data<ActionResult>({ error: "You don't manage an organization." }, { status: 403 });
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "invite") {
    const limited = rateLimitResponse("org_invite", request, user.id);
    if (limited) return data<ActionResult>({ error: "Too many invitations at once. Please wait a few minutes." }, { status: 429 });
    const courseId = String(form.get("courseId") || "");
    const emails = Array.from(
      new Set(
        String(form.get("emails") || "")
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (!courseId) return data<ActionResult>({ error: "Choose a course." }, { status: 400 });
    if (emails.length === 0) return data<ActionResult>({ error: "Enter at least one email address." }, { status: 400 });
    if (emails.length > MAX_INVITES) return data<ActionResult>({ error: `At most ${MAX_INVITES} invitations at a time.` }, { status: 400 });
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) return data<ActionResult>({ error: `Not an email address: ${bad.join(", ")}` }, { status: 400 });

    const invited: string[] = [];
    const skipped: string[] = [];
    let noSeat = 0;
    for (const email of emails) {
      // Already holding or invited to this course in this organization.
      const existing = await prisma.license.findFirst({
        where: {
          organizationId: org.id,
          courseId,
          OR: [
            { status: "ACTIVE", user: { email } },
            { status: "PENDING", assignedEmail: email },
          ],
        },
        select: { id: true },
      });
      if (existing) {
        skipped.push(email);
        continue;
      }
      // Claim one available seat; the guard makes two managers inviting at
      // once take different seats.
      const seat = await prisma.license.findFirst({
        where: { organizationId: org.id, courseId, status: "PENDING", assignedEmail: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, key: true, course: { select: { title: true } } },
      });
      if (!seat) {
        noSeat++;
        continue;
      }
      const claimed = await prisma.license.updateMany({
        where: { id: seat.id, status: "PENDING", assignedEmail: null },
        data: { assignedEmail: email, invitedAt: new Date() },
      });
      if (claimed.count === 0) {
        noSeat++;
        continue;
      }
      recordAttempt("org_invite", request, user.id);
      const sent = await sendSeatInvitationEmail({ to: email, orgName: org.name, courseTitle: seat.course.title, licenseKey: seat.key });
      if (!sent.ok) console.error(`[org] invitation to ${email} (${org.name}) not sent: ${sent.error}`);
      invited.push(email);
    }
    const parts = [];
    if (invited.length) parts.push(`Invited ${invited.length}: ${invited.join(", ")}.`);
    if (skipped.length) parts.push(`Already invited or enrolled: ${skipped.join(", ")}.`);
    if (noSeat) parts.push(`${noSeat} not invited - no seats left for this course.`);
    return data<ActionResult>(invited.length ? { ok: parts.join(" ") } : { error: parts.join(" ") || "Nobody was invited." });
  }

  const id = String(form.get("id") || "");
  const key = id
    ? await prisma.license.findFirst({
        where: { id, organizationId: org.id },
        select: { id: true, key: true, status: true, userId: true, assignedEmail: true, course: { select: { title: true } }, user: { select: { email: true } } },
      })
    : null;
  if (!key) return data<ActionResult>({ error: "That seat is not part of your organization." }, { status: 404 });

  if (intent === "resend") {
    if (key.status !== "PENDING" || !key.assignedEmail) return data<ActionResult>({ error: "That invitation was already accepted or withdrawn." }, { status: 400 });
    const limited = rateLimitResponse("org_invite", request, user.id);
    if (limited) return data<ActionResult>({ error: "Too many emails at once. Please wait a few minutes." }, { status: 429 });
    recordAttempt("org_invite", request, user.id);
    const sent = await sendSeatInvitationEmail({ to: key.assignedEmail, orgName: org.name, courseTitle: key.course.title, licenseKey: key.key });
    await prisma.license.update({ where: { id: key.id }, data: { invitedAt: new Date() } });
    return data<ActionResult>(sent.ok ? { ok: `Invitation sent again to ${key.assignedEmail}.` } : { error: `Could not send the email: ${sent.error}` });
  }

  // Withdraw an invitation / free a seat: the seat gets a NEW key string, so an
  // invitation link already sent (or the old holder's key) stops working.
  if (intent === "withdraw" || intent === "release") {
    const wantActive = intent === "release";
    if (wantActive ? key.status !== "ACTIVE" : key.status !== "PENDING" || !key.assignedEmail) {
      return data<ActionResult>({ error: "That seat changed while you were looking at it. Reload and try again." }, { status: 409 });
    }
    const rekey = (k: string) =>
      prisma.license.updateMany({
        where: wantActive ? { id: key.id, status: "ACTIVE", userId: key.userId } : { id: key.id, status: "PENDING", assignedEmail: key.assignedEmail },
        data: { key: k, status: "PENDING", userId: null, assignedEmail: null, invitedAt: null },
      });
    let r: { count: number };
    try {
      r = await rekey(generateLicenseKey());
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
      r = await rekey(generateLicenseKey());
    }
    if (r.count === 0) return data<ActionResult>({ error: "That seat changed while you were looking at it. Reload and try again." }, { status: 409 });
    const who = key.user?.email ?? key.assignedEmail ?? "the learner";
    console.warn(`[org] ${user.email} (${org.name}) ${wantActive ? "released" : "withdrew"} a "${key.course.title}" seat held by ${who}`);
    return data<ActionResult>({
      ok: wantActive
        ? `${who} no longer has access to "${key.course.title}" (their progress is kept). The seat is available again.`
        : `Invitation for ${who} withdrawn. The seat is available again.`,
    });
  }

  return data<ActionResult>({ error: "Unknown action." }, { status: 400 });
}

export default function OrgPortal() {
  const { org, courses, seats, user } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="min-h-screen bg-brand-beige">
      <header className="bg-brand-navy-deeper text-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Building2 size={22} className="shrink-0 text-brand-mustard" />
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-white/60">Organization seats</p>
              <h1 className="font-display text-xl truncate">{org?.name ?? "No organization"}</h1>
            </div>
          </div>
          <Link to="/student" className="inline-flex items-center gap-1.5 text-sm text-white/80 hover:text-white">
            <ArrowLeft size={15} /> My learning
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {!org ? (
          <div className="rounded-2xl border border-brand-beige-dark bg-white p-8 text-center">
            <Users className="mx-auto w-10 h-10 text-brand-navy/30 mb-3" />
            <p className="text-brand-navy font-semibold">Hi {user.name.split(" ")[0]}, you don't manage an organization.</p>
            <p className="text-sm text-brand-navy/60 mt-1">
              Organization seats appear here when your company buys several seats. Contact support if you expected to see them.
            </p>
          </div>
        ) : (
          <>
            {result && (result.ok || result.error) && (
              <div
                role="status"
                className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
                  result.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {result.ok ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <AlertCircle size={15} className="shrink-0 mt-0.5" />}
                {result.ok ?? result.error}
              </div>
            )}

            {/* Seat balance per course */}
            <section className="grid gap-4 sm:grid-cols-2">
              {courses.length === 0 && (
                <p className="text-sm text-brand-navy/70">No seats yet.</p>
              )}
              {courses.map((c) => (
                <div key={c.id} className="rounded-2xl border border-brand-beige-dark bg-white p-5">
                  <h2 className="font-bold text-brand-navy leading-snug">{c.title}</h2>
                  <p className="text-3xl font-display text-brand-navy mt-2">
                    {c.available} <span className="text-base font-sans text-brand-navy/60">of {c.total} seats available</span>
                  </p>
                  <div className="mt-3 h-2 rounded-full bg-brand-beige-dark overflow-hidden flex" aria-hidden>
                    <div className="bg-brand-green" style={{ width: `${c.total ? (c.inUse / c.total) * 100 : 0}%` }} />
                    <div className="bg-brand-mustard" style={{ width: `${c.total ? (c.invited / c.total) * 100 : 0}%` }} />
                  </div>
                  <p className="text-xs text-brand-navy/60 mt-2">
                    {c.inUse} in use · {c.invited} invited · {c.available} available
                    {c.revoked ? ` · ${c.revoked} revoked` : ""}
                  </p>
                </div>
              ))}
            </section>

            {/* Invite */}
            <section className="rounded-2xl border border-brand-beige-dark bg-white p-5 sm:p-6">
              <h2 className="font-display text-xl text-brand-navy flex items-center gap-2">
                <Mail size={18} /> Invite learners
              </h2>
              <p className="text-sm text-brand-navy/60 mt-1">
                Each invited learner gets an email with a link to join. The seat only works with the email address you invite.
              </p>
              <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <input type="hidden" name="intent" value="invite" />
                <label className="text-sm text-brand-navy font-medium">
                  Course
                  <select name="courseId" required defaultValue="" className="mt-1 w-full border border-brand-beige-dark rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="" disabled>Choose…</option>
                    {courses.filter((c) => c.available > 0).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title} ({c.available} left)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-brand-navy font-medium">
                  Email addresses
                  <textarea
                    name="emails"
                    required
                    rows={1}
                    placeholder="learner@school.org, another@school.org"
                    className="mt-1 w-full border border-brand-beige-dark rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || courses.every((c) => c.available === 0)}
                  className="bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50"
                >
                  Send invitations
                </button>
              </Form>
            </section>

            {/* People */}
            <section className="rounded-2xl border border-brand-beige-dark bg-white overflow-hidden">
              <h2 className="font-display text-xl text-brand-navy px-5 sm:px-6 pt-5">Learners</h2>
              {seats.length === 0 ? (
                <p className="px-6 py-6 text-sm text-brand-navy/60">Nobody has been invited yet.</p>
              ) : (
                <div className="overflow-x-auto mt-3">
                  <table className="min-w-full text-sm">
                    <thead className="bg-brand-beige/60 text-left text-xs uppercase tracking-wider text-brand-navy/60">
                      <tr>
                        <th className="px-5 py-2">Learner</th>
                        <th className="px-5 py-2">Course</th>
                        <th className="px-5 py-2">Status</th>
                        <th className="px-5 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-beige-dark">
                      {seats.map((s) => (
                        <tr key={s.id}>
                          <td className="px-5 py-3">
                            <p className="text-brand-navy font-medium">{s.name ?? s.email}</p>
                            {s.name && <p className="text-xs text-brand-navy/60">{s.email}</p>}
                          </td>
                          <td className="px-5 py-3 text-brand-navy/80">{s.course}</td>
                          <td className="px-5 py-3">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.state === "in use" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                              {s.state === "in use" ? "Enrolled" : "Invited"}
                            </span>
                            {s.since && <p className="text-[11px] text-brand-navy/50 mt-1">{new Date(s.since).toLocaleDateString()}</p>}
                          </td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            {s.state === "invited" ? (
                              <div className="inline-flex gap-2">
                                <Form method="post">
                                  <input type="hidden" name="intent" value="resend" />
                                  <input type="hidden" name="id" value={s.id} />
                                  <button type="submit" disabled={busy} className="inline-flex items-center gap-1 text-xs text-brand-navy hover:underline">
                                    <RotateCcw size={12} /> Resend
                                  </button>
                                </Form>
                                <Form method="post" onSubmit={(e) => { if (!confirm(`Withdraw the invitation for ${s.email}?`)) e.preventDefault(); }}>
                                  <input type="hidden" name="intent" value="withdraw" />
                                  <input type="hidden" name="id" value={s.id} />
                                  <button type="submit" disabled={busy} className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline">
                                    <X size={12} /> Withdraw
                                  </button>
                                </Form>
                              </div>
                            ) : (
                              <Form
                                method="post"
                                onSubmit={(e) => {
                                  if (!confirm(`Remove ${s.email} from "${s.course}"? They lose access (their progress is kept) and the seat becomes available.`)) e.preventDefault();
                                }}
                              >
                                <input type="hidden" name="intent" value="release" />
                                <input type="hidden" name="id" value={s.id} />
                                <button type="submit" disabled={busy} className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline">
                                  <UserMinus size={12} /> Remove from seat
                                </button>
                              </Form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { requireUser } from "../utils/auth.server";
import { prisma } from "../utils/db.server";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";
import {
  Mail,
  Youtube,
  BookOpen,
  Key,
  Search,
  ChevronDown,
  ChevronUp,
  LifeBuoy,
  MessageCircleQuestion,
} from "lucide-react";

const SUPPORT_EMAIL = "info@instructionalgraphics.org";
const SUPPORT_HOURS = "Monday – Friday, 9 AM – 5 PM (Eastern)";
const RESPONSE_SLA = "We typically respond within 1 business day.";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const completedCount = await prisma.progress.count({
    where: { userId: user.id, isCompleted: true },
  });
  return { user, hasCertificates: completedCount > 0 };
}

const FAQS: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: "I have a license key — how do I unlock my course?",
    a: (
      <>
        Click <strong>Redeem Key</strong> in the left sidebar, paste the key
        from your purchase email, and your course will be added to{" "}
        <strong>My Courses</strong> immediately. If your key isn't accepted,
        double-check it and reach out below.
      </>
    ),
  },
  {
    q: "How is my progress saved?",
    a: (
      <>
        Progress is saved automatically as you complete lessons. You can close
        the tab and return any time — your last lesson, video position, and
        completion status are all stored on our server.
      </>
    ),
  },
  {
    q: "Why won't a video or course load?",
    a: (
      <>
        Try a hard refresh (Ctrl+Shift+R / Cmd+Shift+R) first. If that doesn't
        help, switch browsers (Chrome and Firefox tend to handle Storyline
        courses best) or check that JavaScript isn't blocked. If the issue
        persists, email us with the lesson name and we'll investigate.
      </>
    ),
  },
  {
    q: "Can I use the same account on multiple devices?",
    a: (
      <>
        By default, your account is limited to <strong>one active device</strong>{" "}
        at a time — signing in on a new device will sign out the previous one.
        If you need a higher device limit (e.g. you study on both a tablet and a
        laptop), email us and we'll bump it.
      </>
    ),
  },
  {
    q: "I completed a course — where is my certificate?",
    a: (
      <>
        Once a course shows <strong>100% complete</strong>, a certificate icon
        appears on the course card in My Courses. Click it to view and print
        your certificate.
      </>
    ),
  },
  {
    q: "I forgot my password.",
    a: (
      <>
        Sign out and click <strong>Forgot Password</strong> on the login page.
        We'll send a reset link to your registered email — the link expires in 1
        hour for security.
      </>
    ),
  },
  {
    q: "How do I get a refund?",
    a: (
      <>
        Refund requests are handled case-by-case. Email{" "}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="text-brand-mustard hover:underline font-medium"
        >
          {SUPPORT_EMAIL}
        </a>{" "}
        with your order number and a brief description, and we'll get back to
        you.
      </>
    ),
  },
];

export default function StudentHelp() {
  const { user, hasCertificates } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar
          user={user}
          active="help"
          certificatesEnabled={hasCertificates}
        />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar />
          <StudentTopbar user={user} />

          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
            {/* Hero */}
            <div className="mb-10">
              <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
                <LifeBuoy size={14} />
                Help &amp; Support
              </div>
              <h1 className="font-display text-4xl sm:text-5xl text-brand-navy">
                How can we help?
              </h1>
              <p className="text-brand-navy/60 mt-2 max-w-2xl">
                Find answers to common questions below, or reach out — a real
                person will get back to you.
              </p>
            </div>

            {/* Contact cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
              {/* Email */}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="group rounded-2xl bg-brand-navy p-6 shadow-lg hover:shadow-xl transition-shadow flex items-start gap-4 relative overflow-hidden"
              >
                <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-brand-mustard/20 blur-3xl" />
                <div className="relative shrink-0 w-12 h-12 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center">
                  <Mail className="text-white w-6 h-6" />
                </div>
                <div className="relative flex-1 min-w-0">
                  <p className="text-xs font-bold tracking-[0.14em] uppercase text-brand-mustard mb-1">
                    Email us
                  </p>
                  <p className="font-display text-xl text-white leading-tight mb-1 truncate">
                    {SUPPORT_EMAIL}
                  </p>
                  <p className="text-white/70 text-sm leading-relaxed">
                    {RESPONSE_SLA}
                  </p>
                  <p className="text-white/50 text-xs mt-2">{SUPPORT_HOURS}</p>
                </div>
              </a>

              {/* YouTube */}
              <a
                href="https://www.youtube.com/@TeachMeLikeATot"
                target="_blank"
                rel="noopener noreferrer"
                className="group rounded-2xl bg-white border border-brand-beige-dark p-6 hover:border-brand-mustard/40 transition-colors flex items-start gap-4"
              >
                <div className="shrink-0 w-12 h-12 rounded-xl bg-brand-mustard/15 flex items-center justify-center">
                  <Youtube className="text-brand-mustard w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold tracking-[0.14em] uppercase text-brand-mustard mb-1">
                    Browse content
                  </p>
                  <p className="font-display text-xl text-brand-navy leading-tight mb-1">
                    Watch on YouTube
                  </p>
                  <p className="text-brand-navy/60 text-sm leading-relaxed">
                    Short, simple videos covering everything from market basics
                    to advanced topics.
                  </p>
                </div>
              </a>
            </div>

            {/* FAQ */}
            <section className="mb-12">
              <div className="flex items-center gap-2 mb-5">
                <MessageCircleQuestion
                  className="text-brand-navy"
                  size={22}
                />
                <h2 className="font-display text-2xl text-brand-navy">
                  Frequently asked questions
                </h2>
              </div>

              <div className="rounded-2xl border border-brand-beige-dark bg-white divide-y divide-brand-beige-dark overflow-hidden">
                {FAQS.map((item, i) => (
                  <FaqRow key={i} q={item.q} a={item.a} />
                ))}
              </div>
            </section>

            {/* Quick links */}
            <section className="mb-4">
              <h2 className="font-display text-2xl text-brand-navy mb-5">
                Quick links
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <QuickLink
                  to="/student"
                  icon={BookOpen}
                  title="My Courses"
                  subtitle="Continue learning"
                />
                <QuickLink
                  to="/catalog"
                  icon={Search}
                  title="Browse Courses"
                  subtitle="Explore the catalog"
                />
                <QuickLink
                  to="/redeem"
                  icon={Key}
                  title="Redeem Key"
                  subtitle="Unlock a purchased course"
                />
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

// ── FAQ Row ──────────────────────────────────────────────────────────────────

function FaqRow({ q, a }: { q: string; a: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-5 sm:px-6 py-4 text-left hover:bg-brand-beige/40 transition-colors"
        aria-expanded={open}
      >
        <span className="text-brand-navy font-semibold text-sm sm:text-base">
          {q}
        </span>
        {open ? (
          <ChevronUp className="text-brand-navy/60 shrink-0" size={18} />
        ) : (
          <ChevronDown className="text-brand-navy/60 shrink-0" size={18} />
        )}
      </button>
      {open && (
        <div className="px-5 sm:px-6 pb-5 -mt-1 text-brand-navy/75 text-sm leading-relaxed">
          {a}
        </div>
      )}
    </div>
  );
}

// ── Quick link card ──────────────────────────────────────────────────────────

function QuickLink({
  to,
  icon: Icon,
  title,
  subtitle,
}: {
  to: string;
  icon: React.ElementType;
  title: string;
  subtitle: string;
}) {
  return (
    <a
      href={to}
      className="block rounded-2xl border border-brand-beige-dark bg-white p-5 hover:border-brand-navy/30 hover:shadow-sm transition-all"
    >
      <div className="w-10 h-10 rounded-lg bg-brand-navy/10 flex items-center justify-center mb-3">
        <Icon className="text-brand-navy w-5 h-5" />
      </div>
      <p className="font-display text-lg text-brand-navy leading-tight">
        {title}
      </p>
      <p className="text-brand-navy/60 text-sm mt-0.5">{subtitle}</p>
    </a>
  );
}

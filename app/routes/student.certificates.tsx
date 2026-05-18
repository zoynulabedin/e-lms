import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireUser } from "../utils/auth.server";
import { prisma } from "../utils/db.server";
import {
  StudentSidebar,
  StudentMobileTopbar,
  StudentTopbar,
} from "../components/StudentSidebar";
import { Toast } from "../components/Toast";
import { Award, BookOpen, Download, ExternalLink, Search } from "lucide-react";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const completed = await prisma.progress.findMany({
    where: { userId: user.id, isCompleted: true },
    include: { course: true },
    orderBy: { completedAt: "desc" },
  });

  return {
    user,
    certificates: completed.map((p) => ({
      courseId: p.courseId,
      courseTitle: p.course?.title ?? "Untitled course",
      courseThumbnail: p.course?.thumbnailUrl ?? null,
      courseCategory: p.course?.category ?? null,
      completedAt: p.completedAt,
    })),
    hasCertificates: completed.length > 0,
  };
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function StudentCertificates() {
  const { user, certificates, hasCertificates } =
    useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-brand-beige">
      <Toast />

      <div className="flex">
        <StudentSidebar
          user={user}
          active="certificates"
          certificatesEnabled={hasCertificates}
        />

        <main className="flex-1 min-w-0">
          <StudentMobileTopbar />
          <StudentTopbar user={user} />

          <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 lg:py-10">
            {/* Hero */}
            <div className="mb-10">
              <div className="flex items-center gap-2 text-brand-mustard text-xs font-bold tracking-[0.18em] uppercase mb-2">
                <Award size={14} />
                Certificates
              </div>
              <h1 className="font-display text-4xl sm:text-5xl text-brand-navy">
                Your Achievements
              </h1>
              <p className="text-brand-navy/60 mt-2 max-w-2xl">
                Every course you've completed lives here. Click any card to view
                or print your certificate.
              </p>
            </div>

            {certificates.length === 0 ? (
              <div className="text-center py-20 border-2 border-dashed border-brand-beige-dark rounded-2xl bg-white">
                <div className="w-14 h-14 rounded-full bg-brand-mustard/15 flex items-center justify-center mx-auto mb-4">
                  <Award className="text-brand-mustard w-7 h-7" />
                </div>
                <p className="font-display text-2xl text-brand-navy mb-1">
                  No certificates yet
                </p>
                <p className="text-brand-navy/60 text-sm mb-6 max-w-md mx-auto">
                  Complete any course in your library to earn your first
                  certificate.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <Link
                    to="/student"
                    className="inline-flex items-center gap-2 bg-brand-navy hover:bg-brand-navy-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
                  >
                    <BookOpen size={14} /> My Courses
                  </Link>
                  <Link
                    to="/catalog"
                    className="inline-flex items-center gap-2 border border-brand-beige-dark hover:border-brand-navy text-brand-navy text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
                  >
                    <Search size={14} /> Browse Courses
                  </Link>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {certificates.map((c) => (
                  <CertCard key={c.courseId} c={c} />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Certificate card ─────────────────────────────────────────────────────────

function CertCard({
  c,
}: {
  c: {
    courseId: string;
    courseTitle: string;
    courseThumbnail: string | null;
    courseCategory: string | null;
    completedAt: Date | string | null;
  };
}) {
  return (
    <div className="bg-white rounded-2xl border border-brand-beige-dark overflow-hidden hover:border-brand-mustard/50 transition-colors group">
      {/* Thumbnail with award badge overlay */}
      <div className="relative h-36 bg-brand-navy">
        {c.courseThumbnail ? (
          <img
            src={c.courseThumbnail}
            alt={c.courseTitle}
            className="w-full h-full object-cover opacity-60 group-hover:opacity-75 transition-opacity"
          />
        ) : (
          <div className="absolute inset-0 bg-linear-to-br from-brand-navy via-brand-navy-dark to-brand-navy-deeper" />
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-14 h-14 rounded-full bg-brand-mustard/95 flex items-center justify-center shadow-lg">
            <Award className="text-white w-7 h-7" />
          </div>
        </div>
        {c.courseCategory && (
          <div className="absolute top-3 left-3 bg-white/90 backdrop-blur text-brand-navy rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider">
            {c.courseCategory}
          </div>
        )}
      </div>

      <div className="p-5">
        <h3 className="font-display text-lg text-brand-navy leading-snug line-clamp-2 mb-2">
          {c.courseTitle}
        </h3>
        <p className="text-xs text-brand-navy/55 mb-4">
          Completed {formatDate(c.completedAt)}
        </p>

        <div className="flex items-center gap-2">
          <a
            href={`/certificate/${c.courseId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-1.5 bg-brand-navy hover:bg-brand-navy-dark text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
          >
            <ExternalLink size={13} /> View
          </a>
          <a
            href={`/certificate/${c.courseId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 border border-brand-mustard/40 hover:bg-brand-mustard/10 text-brand-mustard text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
            title="View — then use your browser's print dialog to save as PDF"
          >
            <Download size={13} /> Print
          </a>
        </div>
      </div>
    </div>
  );
}

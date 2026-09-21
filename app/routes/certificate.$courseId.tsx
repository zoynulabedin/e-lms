import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { randomUUID } from "crypto";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { resolveCertificateConfig, certificateHeaders } from "../utils/certificate.server";
import { renderCertificateHtml, certificateSerial } from "../utils/certificate-template";

/**
 * GET /certificate/:courseId
 *
 * The learner's certificate, as a printable HTML page. The design comes from
 * the admin-editable template (app/routes/certificate-design.tsx); the markup
 * itself is produced by the shared renderer in utils/certificate-template.ts,
 * which the admin's live preview also calls, so the two cannot drift.
 *
 * If the template table has not been migrated onto this server yet, the
 * resolver falls back to the built-in defaults and this page keeps working.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const courseId = params.courseId!;

  // Explicit select, not include: an include pulls every scalar column, so a
  // column added by a migration that has not been applied on this server would
  // take the page down.
  const progress = await prisma.progress.findUnique({
    where: { userId_courseId: { userId: user.id, courseId } },
    select: {
      id: true,
      completedAt: true,
      course: { select: { title: true, summary: true, instructor: true } },
    },
  });

  // completedAt is set the first time the learner finishes and is never
  // cleared - an issued certificate stays valid even if the admin later adds
  // material and isCompleted drops until the new items are done.
  if (!progress || !progress.completedAt) {
    throw data(
      { message: "Certificate not available. Complete the course first." },
      { status: 403 },
    );
  }

  const { config } = await resolveCertificateConfig();

  // A per-response nonce for the print button's listener. CSP nonces do not
  // apply to inline event handlers, which is why the button uses
  // addEventListener in a nonce'd <script> rather than onclick=.
  const nonce = randomUUID();

  const html = renderCertificateHtml(
    config,
    {
      learnerName: user.name,
      courseTitle: progress.course?.title ?? "Untitled course",
      courseSummary: progress.course?.summary ?? null,
      completedAt: progress.completedAt,
      instructor: progress.course?.instructor ?? null,
      certificateId: certificateSerial(
        progress.id,
        progress.course?.title ?? "",
        config.certificateIdPrefix,
      ),
    },
    { printNonce: nonce },
  );

  return new Response(html, { headers: certificateHeaders({ nonce }) });
}

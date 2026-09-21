import type { LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { resolveCertificateConfig, certificateHeaders } from "../utils/certificate.server";
import { renderCertificateHtml, certificateSerial } from "../utils/certificate-template";

/**
 * GET /certificate-design/preview — the admin's "Open as learner" view.
 *
 * Renders the SAVED design exactly as the learner route does, in a new tab, so
 * the admin can hit Ctrl+P and see real paper output. The editor's own live
 * preview is client-side; this route is the ground truth it is checked against.
 *
 * Registered outside the admin layout because it returns raw HTML rather than
 * a page, so requireAdmin has to be the first statement of its own loader —
 * a resource request runs only the leaf loader, not the layout's.
 *
 * It renders SAMPLE data, never a real learner's certificate: showing one
 * person's document inside an admin tool is not something this feature needs,
 * and not having the capability means it cannot be misused.
 */
const SAMPLE_TITLE = "Money Talks: Teaching Kids About Saving";
const SAMPLE_SUMMARY =
  "An animated course in personal finance, budgeting and smart spending - 3.5 contact hours";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const { config } = await resolveCertificateConfig();

  // Preview against a REAL course title where one exists. A 62-character title
  // should break the layout while the admin is still editing, not after a
  // learner has printed it.
  // No orderBy: sorting by title and taking 40 would pick the alphabetically
  // last courses, which says nothing about length. A course list is small
  // enough to scan whole.
  const longest = await prisma.course
    .findMany({ select: { title: true, summary: true }, take: 500 })
    .then((rows) => rows.sort((a, b) => b.title.length - a.title.length)[0] ?? null)
    .catch(() => null);

  const nonce = randomUUID();
  const html = renderCertificateHtml(
    config,
    {
      learnerName: "Jamie Rivera",
      courseTitle: longest?.title ?? SAMPLE_TITLE,
      courseSummary: longest?.summary ?? SAMPLE_SUMMARY,
      completedAt: new Date(),
      instructor: "Denise Carter",
      certificateId: certificateSerial(
        "6c1f4a9e-0000-4000-8000-000000000000",
        longest?.title ?? SAMPLE_TITLE,
        config.certificateIdPrefix,
      ),
    },
    { printNonce: nonce },
  );

  return new Response(html, { headers: certificateHeaders({ nonce }) });
}

import { data, redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { getCourseAccess } from "../utils/access.server";

/**
 * Gated download for a course resource or a DOWNLOAD lesson's file.
 *
 * The learner's link is always /student/resource/<id>; the underlying storage
 * URL (Cloudinary) is never serialized into a page, so it cannot be copied out
 * of the HTML or DevTools and shared. Every request re-checks the licence for
 * the resource's own course, so:
 *   • a learner enrolled in another course gets 403
 *   • revoking a licence blocks the file immediately
 *   • an old link someone forwarded is useless to anyone without the licence
 *
 * FILE resources are streamed through this server. LINK resources (YouTube,
 * Vimeo, any external page) redirect, since we cannot proxy a third-party
 * player anyway — that difference is called out in the admin UI.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const id = params.resourceId!;

  type Gated = {
    courseId: string;
    title: string;
    kind: string;
    url: string;
    fileName: string | null;
    fileType: string | null;
  };

  let resource: Gated | null = null;

  const row = await prisma.courseResource
    .findUnique({
      where: { id },
      select: {
        courseId: true,
        title: true,
        kind: true,
        url: true,
        fileName: true,
        fileType: true,
        isActive: true,
      },
    })
    .catch(() => null);

  if (row) {
    if (!row.isActive) throw data({ message: "Resource not found." }, { status: 404 });
    resource = row;
  } else {
    // The same id space also covers DOWNLOAD lessons, whose file lives on the
    // lesson itself. Gating them here means no learner-facing page ever needs
    // to print a raw storage URL.
    const lesson = await prisma.lesson.findUnique({
      where: { id },
      select: {
        title: true,
        resourceUrl: true,
        lessonType: true,
        module: { select: { courseId: true } },
      },
    });
    if (lesson?.resourceUrl && lesson.lessonType === "DOWNLOAD") {
      resource = {
        courseId: lesson.module.courseId,
        title: lesson.title,
        kind: "FILE",
        url: lesson.resourceUrl,
        fileName: null,
        fileType: null,
      };
    }
  }

  if (!resource) {
    throw data({ message: "Resource not found." }, { status: 404 });
  }

  const access = await getCourseAccess(user.id, resource.courseId);
  if (!access.hasAccess) {
    throw data(
      { message: "This resource belongs to a course you don't have access to." },
      { status: 403 },
    );
  }

  if (resource.kind === "LINK") return redirect(resource.url);

  // Stream the file from storage. `duplex` is required by Node's fetch when a
  // body is piped through; the upstream response body is passed straight on so
  // large PDFs never sit in memory.
  const upstream = await fetch(resource.url).catch((err) => {
    console.error(`[resource] fetch failed for ${id}:`, err);
    return null;
  });

  if (!upstream || !upstream.ok) {
    console.error(`[resource] storage returned ${upstream?.status ?? "no response"} for ${id}`);
    throw data({ message: "This file could not be retrieved. Please try again." }, { status: 502 });
  }

  const filename = (resource.fileName || resource.title || "download").replace(/["\\]/g, "");
  const headers = new Headers({
    "Content-Type": resource.fileType || upstream.headers.get("content-type") || "application/octet-stream",
    // `inline` lets PDFs open in the browser's viewer; the filename is still
    // used when the learner chooses "Save as".
    "Content-Disposition": `inline; filename="${filename}"`,
    // Private: this response is licence-gated, so no shared cache may keep it.
    "Cache-Control": "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}

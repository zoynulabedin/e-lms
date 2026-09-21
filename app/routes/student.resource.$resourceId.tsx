import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { cloudinaryFetchUrl } from "../utils/cloudinary.server";
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
/**
 * A small HTML page for the failure cases.
 *
 * This is a resource route: it has no component, so a thrown `data()` is
 * serialized straight to the browser and the learner sees raw JSON like
 * {"message":"..."} in a blank tab. That is not an error message, it is a
 * glitch. These pages say what happened and where to go next.
 */
function errorPage(status: number, title: string, detail: string, backTo = "/student/resources") {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f4ede8; color: #1d375f;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 1px solid #d5cfca; border-radius: 16px; padding: 40px;
          max-width: 460px; width: 100%; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 10px; }
  p { font-size: 14px; line-height: 1.6; color: rgba(29,55,95,.72); }
  a { display: inline-block; margin-top: 24px; background: #1d375f; color: #fff;
      text-decoration: none; font-size: 14px; font-weight: 600; padding: 10px 22px; border-radius: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
    <a href="${esc(backTo)}">Back to my resources</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

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
    if (!row.isActive) {
      throw errorPage(
        404,
        "This file is not available",
        "Your instructor has hidden it for now. It may come back later.",
      );
    }
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
    // Any lesson carrying a file, not only DOWNLOAD ones - the lesson editor
    // writes resourceUrl from "Exercise Files" on video/text/storyline lessons
    // too, and those links have to resolve rather than 404.
    if (lesson?.resourceUrl) {
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
    throw errorPage(
      404,
      "File not found",
      "This link does not point at anything any more — the file may have been removed.",
    );
  }

  // Admins manage every course, so they can open any file - otherwise there
  // is no way to check that an upload actually landed, and an admin following
  // a link from the site gets a 403 they cannot explain.
  if (user.role !== "ADMIN") {
    const access = await getCourseAccess(user.id, resource.courseId);
    if (!access.hasAccess) {
      // A 403 here is invisible in the UI - it is a download, not a page - so
      // say in the log exactly why it was refused and what the user DOES hold.
      // Without this the only evidence is a bare 403 in the access log.
      const held = await prisma.license
        .findMany({
          where: { userId: user.id },
          select: { courseId: true, status: true },
        })
        .catch(() => [] as Array<{ courseId: string; status: string }>);
      console.warn(
        `[resource] 403 ${user.email} -> resource ${id} (course ${resource.courseId}). ` +
          `Their licences: ${
            held.length
              ? held.map((l) => `${l.courseId}=${l.status}`).join(", ")
              : "none"
          }`,
      );
      throw errorPage(
        403,
        "You don't have access to this file",
        "It belongs to a course you don't currently own. If you have a licence key for it, " +
          "redeem the key and the file will appear in your resources.",
        "/redeem",
      );
    }
  }

  if (resource.kind === "LINK") return redirect(resource.url);

  // Stream the file from storage, so the learner's browser never sees where it
  // actually lives. The entitlement check above has already run either way.
  //
  // For a Cloudinary asset, ask for an authenticated download URL rather than
  // using the stored one: an account with restricted delivery answers 401 on
  // the plain URL, even to the server that uploaded the file.
  const fetchUrl = cloudinaryFetchUrl(resource.url) ?? resource.url;

  let upstream: Response | null = null;
  let failure = "";
  try {
    upstream = await fetch(fetchUrl, { redirect: "follow" });
    if (!upstream.ok) failure = `HTTP ${upstream.status}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (failure) {
    // Name the file and the reason. A download has no UI to show an error in,
    // so without this the only trace is a bare 502 in the access log.
    let hint = "";
    const isCloudinary = resource.url.startsWith("https://res.cloudinary.com/");
    if (isCloudinary && failure === "HTTP 401") {
      hint =
        " — Cloudinary refused even the signed download. Check Settings → Security " +
        'for restricted delivery, and that "Allow delivery of PDF and ZIP files" is on.';
    } else if (!isCloudinary) {
      hint =
        " — this URL was typed in by hand rather than uploaded. It has to be a " +
        "direct, publicly fetchable file link, not a share page (Google Drive, " +
        "Dropbox and OneDrive share links do not work).";
    }
    console.error(
      `[resource] storage failed for ${id} (${failure}). URL: ${resource.url}${hint}`,
    );

    // The learner still gets their file: hand them the storage URL rather than
    // a dead end. The licence check above has already passed, so this grants
    // nothing to anyone who was not entitled - it only stops hiding where the
    // file is kept, which the streamed path does as a bonus, not as the
    // entitlement rule. Better a visible URL than a download that never works.
    // The learner still gets their file: hand them the best URL we have
    // rather than a dead end. The licence check above has already passed, so
    // this grants nothing to anyone who was not entitled. The signed form is
    // preferred because it expires in minutes, so a forwarded link dies fast.
    return redirect(fetchUrl);
  }

  if (!upstream) {
    throw errorPage(
      502,
      "This file could not be opened",
      "Something went wrong fetching it. Please try again, and tell us if it keeps happening.",
    );
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

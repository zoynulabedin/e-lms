import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { requireUser } from "../utils/auth.server";
import { data } from "react-router";

/**
 * GET /certificate/:courseId
 * Returns a simple HTML certificate for completed courses.
 * Can be printed / saved as PDF by the browser.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const courseId = params.courseId!;

  const progress = await prisma.progress.findUnique({
    where: { userId_courseId: { userId: user.id, courseId } },
    include: { course: true },
  });

  if (!progress || !progress.isCompleted) {
    throw data(
      { message: "Certificate not available. Complete the course first." },
      { status: 403 },
    );
  }

  const completedDate = progress.completedAt
    ? new Date(progress.completedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Certificate – ${progress.course.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display:wght@700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 40px; }
    .cert { background: #fff; border: 2px solid #e5e7eb; border-radius: 16px; padding: 64px 72px; max-width: 780px; width: 100%; text-align: center; position: relative; overflow: hidden; }
    .cert::before { content: ''; position: absolute; inset: 12px; border: 1.5px dashed #d1fae5; border-radius: 10px; pointer-events: none; }
    .badge { display: inline-flex; align-items: center; justify-content: center; width: 72px; height: 72px; background: linear-gradient(135deg, #1D375F, #C69445); border-radius: 50%; margin-bottom: 28px; }
    .badge svg { width: 36px; height: 36px; fill: none; stroke: white; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .org { font-size: 13px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
    h1 { font-family: 'Playfair Display', serif; font-size: 42px; color: #111827; margin-bottom: 20px; }
    .sub { font-size: 16px; color: #374151; margin-bottom: 8px; }
    .name { font-size: 32px; font-weight: 700; color: #1D375F; margin-bottom: 8px; }
    .course { font-size: 20px; font-weight: 600; color: #111827; margin: 24px auto; max-width: 480px; line-height: 1.4; }
    .date { font-size: 14px; color: #9ca3af; margin-top: 32px; }
    .divider { width: 80px; height: 3px; background: linear-gradient(90deg, #1D375F, #C69445); border-radius: 2px; margin: 28px auto; }
    @media print { body { background: white; padding: 0; } .cert { border: none; border-radius: 0; padding: 48px 56px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="cert">
    <div class="badge">
      <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
    </div>
    <p class="org">InstructionalGraphics Academy</p>
    <h1>Certificate of Completion</h1>
    <div class="divider"></div>
    <p class="sub">This certifies that</p>
    <p class="name">${user.name}</p>
    <p class="sub">has successfully completed</p>
    <p class="course">${progress.course.title}</p>
    <p class="date">Completed on ${completedDate}</p>
    <div style="margin-top:40px;">
      <button onclick="window.print()" class="no-print" style="background:#1D375F;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;">
        Download / Print Certificate
      </button>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

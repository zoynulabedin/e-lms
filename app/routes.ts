import {
  type RouteConfig,
  layout,
  index,
  route,
} from "@react-router/dev/routes";

export default [
  // ─── Auth (no layout) ──────────────────────────────────────────────
  route("auth/login", "routes/auth.login.tsx"),
  route("auth/register", "routes/auth.register.tsx"),
  route("auth/logout", "routes/auth.logout.tsx"),
  route("auth/forgot-password", "routes/auth.forgot-password.tsx"),
  route("auth/reset-password", "routes/auth.reset-password.tsx"),

  // ─── License redemption (public / semi-public) ─────────────────────
  route("redeem", "routes/redeem.tsx"),

  // ─── Public course catalog ──────────────────────────────────────────
  route("catalog", "routes/catalog.tsx"),

  // ─── Student area (no admin sidebar) ───────────────────────────────
  route("student", "routes/student.dashboard.tsx"),
  route("student/course/:courseId", "routes/student.course.$courseId.tsx"),
  route("student/quiz-history", "routes/student.quiz-history.tsx"),
  route("student/help", "routes/student.help.tsx"),
  route("student/certificates", "routes/student.certificates.tsx"),

  // ─── Certificate (raw HTML response) ───────────────────────────────
  route("certificate/:courseId", "routes/certificate.$courseId.tsx"),

  // ─── Shopify webhook ────────────────────────────────────────────────
  route("shopify/webhook", "routes/shopify.webhook.tsx"),

  // ─── Reports CSV export ─────────────────────────────────────────────
  route("reports/export", "routes/reports.export.tsx"),

  // ─── Cloudinary image upload ─────────────────────────────────────────
  route("upload", "routes/upload.tsx"),

  // ─── Admin (protected by layout loader) ────────────────────────────
  layout("routes/layout.tsx", [
    index("routes/home.tsx"),
    route("courses", "routes/courses.tsx"),
    route("courses/:courseId", "routes/courses.$courseId.tsx"),
    route("licenses", "routes/licenses.tsx"),
    route("users", "routes/users.tsx"),
    route("sessions", "routes/sessions.tsx"),
    route("reports", "routes/reports.tsx"),
    route("settings", "routes/settings.tsx"),
    route("quiz-review", "routes/quiz-review.tsx"),
  ]),
] satisfies RouteConfig;

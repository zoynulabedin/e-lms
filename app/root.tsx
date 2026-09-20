import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigate,
} from "react-router";
import { useMemo } from "react";

import type { Route } from "./+types/root";
import "./app.css";

export function headers() {
  return {
    // 'unsafe-inline' stays for React Router's hydration script; 'unsafe-eval'
    // and the blanket https: script source are gone. frame-ancestors blocks
    // clickjacking, HSTS pins HTTPS, nosniff stops MIME confusion.
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https:",
      "font-src 'self' https://fonts.gstatic.com data:",
      "frame-src 'self' https:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=ADLaM+Display&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** Short, readable id so a user can quote it and we can grep the log for it. */
function newErrorId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2);
  return rnd.slice(0, 8).toUpperCase();
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const navigate = useNavigate();
  const location = useLocation();
  // entry.server's handleError already stamped server-thrown errors with an
  // id and logged it; reuse that so the code on screen matches the log line.
  // Errors that never touched the server (render/hydration) get a fresh id.
  const errorId = useMemo(() => {
    const stamped =
      error && typeof error === "object"
        ? (error as { __errorId?: string }).__errorId
        : undefined;
    return stamped ?? newErrorId();
  }, [error]);

  let status = 500;
  let title = "Something went wrong";
  let message = "An unexpected error occurred. Please try again.";
  let showStack = false;
  let stack: string | undefined;
  // Only genuine crashes get an id + log line; 404/403 are normal traffic.
  let isUnexpected = false;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    // Loaders/actions throw data({ message }) or data({ error }) with the
    // human-readable reason - prefer that over a generic line.
    const detail =
      error.data && typeof error.data === "object"
        ? (error.data as { message?: string; error?: string }).message ??
          (error.data as { message?: string; error?: string }).error
        : typeof error.data === "string"
          ? error.data
          : undefined;
    if (error.status === 404) {
      title = "Page not found";
      message = detail || "The page you're looking for doesn't exist or has been moved.";
    } else if (error.status === 401 || error.status === 403) {
      title = "Access denied";
      message = detail || "You don't have permission to view this page.";
    } else if (error.status === 429) {
      title = "Slow down";
      message = detail || "Too many requests. Please wait a few minutes and try again.";
    } else if (error.status === 500) {
      title = "Server error";
      message = detail || error.statusText || message;
    } else {
      title = `Error ${error.status}`;
      message = detail || error.statusText || message;
    }
  } else if (error instanceof Error) {
    // Prisma schema-drift errors are a deploy mistake, not a bug: say so
    // plainly rather than "an unexpected error occurred". No data is exposed.
    const code = (error as { code?: string }).code;
    const text = `${error.message} ${(error as { meta?: unknown }).meta ? JSON.stringify((error as { meta?: any }).meta) : ""}`;
    const schemaDrift =
      code === "P2021" ||
      code === "P2022" ||
      /does not exist in the current database|column .* does not exist|relation .* does not exist/i.test(text);

    isUnexpected = !schemaDrift;

    if (schemaDrift) {
      title = "Database is out of date";
      message =
        "The app was deployed but its database migrations have not been applied yet. " +
        "Run `npm run migrate:prod` on the server (or just restart the app — it migrates on boot) and reload this page.";
      showStack = false;
    } else {
      message = import.meta.env.DEV ? error.message : message;
      stack = import.meta.env.DEV ? error.stack : undefined;
      showStack = !!stack;
    }
  }

  // Log once, with enough context to find the request in the host's log.
  // Runs on the server for document requests and in the browser for errors
  // during client-side navigation.
  useMemo(() => {
    if (!isUnexpected) return;
    const stamped =
      error && typeof error === "object" && (error as { __errorId?: string }).__errorId;
    // Server errors are already logged by handleError in entry.server.
    if (stamped) return;
    const where = `${location.pathname}${location.search}`;
    console.error(`[app] ${errorId} error at ${where}:`, error);
  }, [errorId, isUnexpected, location.pathname, location.search, error]);

  const statusColors: Record<number, string> = {
    404: "text-blue-400",
    401: "text-yellow-400",
    403: "text-yellow-400",
    500: "text-red-400",
  };
  const statusColor = statusColors[status] || "text-red-400";

  return (
    <main className="min-h-screen bg-linear-to-br from-brand-navy-dark via-brand-navy to-brand-navy-dark flex items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        {/* Status code */}
        <p className={`text-8xl font-black mb-4 ${statusColor}`}>{status}</p>

        {/* Title */}
        <h1 className="text-2xl font-bold text-white mb-3">{title}</h1>

        {/* Message */}
        <p className="text-slate-400 text-sm mb-4 leading-relaxed">{message}</p>

        {/* Reference for support */}
        {isUnexpected && (
          <p className="text-slate-500 text-xs mb-8">
            Reference:{" "}
            <code className="font-mono text-slate-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
              {errorId}
            </code>
            <span className="block mt-1">Quote this code when reporting the problem.</span>
          </p>
        )}
        {!isUnexpected && <div className="mb-8" />}

        {/* Actions */}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="px-5 py-2.5 rounded-lg border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/5 transition-colors"
          >
            ← Go back
          </button>
          <button
            onClick={() => navigate("/")}
            className="px-5 py-2.5 rounded-lg bg-brand-navy text-white text-sm font-medium hover:bg-brand-navy-dark transition-colors"
          >
            Go to dashboard
          </button>
        </div>

        {/* Dev stack trace */}
        {showStack && stack && (
          <details className="mt-8 text-left">
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400 mb-2">
              Stack trace (dev only)
            </summary>
            <pre className="bg-black/40 border border-white/10 rounded-lg p-4 text-xs text-red-300 overflow-x-auto whitespace-pre-wrap">
              {stack}
            </pre>
          </details>
        )}
      </div>
    </main>
  );
}

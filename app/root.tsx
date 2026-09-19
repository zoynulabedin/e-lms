import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
} from "react-router";

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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const navigate = useNavigate();

  let status = 500;
  let title = "Something went wrong";
  let message = "An unexpected error occurred. Please try again.";
  let showStack = false;
  let stack: string | undefined;

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
    message = import.meta.env.DEV ? error.message : message;
    stack = import.meta.env.DEV ? error.stack : undefined;
    showStack = !!stack;
  }

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
        <p className="text-slate-400 text-sm mb-8 leading-relaxed">{message}</p>

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

import { data, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getSessionUser } from "../utils/auth.server";

/**
 * Catch-all for unknown URLs. Returning (not throwing) a 404 renders this
 * friendly page with the right status code and keeps the server log clean.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const user = await getSessionUser(request).catch(() => null);
  return data(
    {
      path: url.pathname,
      home: user ? (user.role === "ADMIN" ? "/" : "/student") : "/auth/login",
    },
    { status: 404 },
  );
}

export function meta() {
  return [{ title: "Page not found" }];
}

export default function NotFound() {
  const { path, home } = useLoaderData<typeof loader>();

  return (
    <main className="min-h-screen bg-linear-to-br from-brand-navy-dark via-brand-navy to-brand-navy-dark flex items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        <p className="text-8xl font-black mb-4 text-blue-400">404</p>
        <h1 className="text-2xl font-bold text-white mb-3">Page not found</h1>
        <p className="text-slate-400 text-sm mb-2 leading-relaxed">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <p className="text-slate-500 text-xs font-mono mb-8 break-all">{path}</p>
        <div className="flex items-center justify-center gap-3">
          <Link
            to={home}
            className="px-5 py-2.5 rounded-lg bg-brand-navy text-white text-sm font-medium hover:bg-brand-navy-dark transition-colors"
          >
            Go to dashboard
          </Link>
          <Link
            to="/catalog"
            className="px-5 py-2.5 rounded-lg border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/5 transition-colors"
          >
            Browse courses
          </Link>
        </div>
      </div>
    </main>
  );
}

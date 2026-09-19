import type { LoaderFunctionArgs } from "react-router";

/**
 * `/.well-known/*` is probed by browsers and tools (Chrome DevTools asks for
 * `/.well-known/appspecific/com.chrome.devtools.json` on every page load).
 * We publish nothing there, so answer with a bare 404 instead of routing the
 * request through the app and logging "No route matches URL" each time.
 */
export function loader(_args: LoaderFunctionArgs) {
  return new Response(null, { status: 404 });
}

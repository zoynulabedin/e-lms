import { PassThrough } from "node:stream";

import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext,
  // If you have middleware enabled:
  // loadContext: RouterContextProvider
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );
  });
}

/**
 * Called for every error thrown in a loader/action on the server — for full
 * page loads AND for the `.data` requests that client-side navigation makes.
 *
 * It stamps the error with a short id, logs it with the request context, and
 * attaches that id to the error object so the ErrorBoundary can show the same
 * code to the user. Grep the host's error log for the code the user quotes.
 */
export function handleError(
  error: unknown,
  { request }: { request: Request },
) {
  // Aborted navigations are not failures.
  if (request.signal.aborted) return;

  const id =
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2)
    )
      .slice(0, 8)
      .toUpperCase();

  // Let the ErrorBoundary reuse this id when it renders on the server.
  if (error && typeof error === "object") {
    (error as { __errorId?: string }).__errorId = id;
  }

  const url = new URL(request.url);
  // React Router replaces the error with a bare Error("Unexpected Server
  // Error") before the ErrorBoundary sees it in production, so `code`/`meta`
  // (Prisma's schema-drift signals) only exist here. Log them.
  const e = error as { code?: string; meta?: unknown };
  const extra = [
    e?.code ? `code=${e.code}` : null,
    e?.meta ? `meta=${JSON.stringify(e.meta)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(
    `[app] ${id} ${new Date().toISOString()} ${request.method} ${url.pathname}${url.search}` +
      (extra ? ` ${extra}` : ""),
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
}

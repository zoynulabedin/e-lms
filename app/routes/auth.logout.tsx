import { redirect } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { clearSessionCookie, invalidateSession } from "../utils/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  await invalidateSession(request);
  return redirect("/auth/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

// Logging out is a state change, so it only happens on POST. A plain GET
// (a link on another site, a browser prefetch) just lands on the login page.
export async function loader(_args: LoaderFunctionArgs) {
  return redirect("/auth/login");
}

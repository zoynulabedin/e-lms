import { redirect } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { clearSessionCookie, invalidateSession } from "../utils/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  await invalidateSession(request);
  return redirect("/auth/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  await invalidateSession(request);
  return redirect("/auth/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

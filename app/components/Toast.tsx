import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

const MESSAGES: Record<string, string> = {
  welcome: "Welcome back! You're signed in.",
  registered: "Account created successfully! Welcome aboard.",
};

export type ToastTone = "success" | "error";

type ToastState = { id: number; message: string; tone: ToastTone };

const TOAST_EVENT = "app:toast";
let nextId = 1;

/**
 * Shows a toast from client code, e.g. after an upload finishes.
 *
 * It only appears where a <Toast /> is mounted: the admin layout and the
 * learner resources page. Errors stay up longer than successes so the reason
 * can be read.
 */
export function showToast(message: string, tone: ToastTone = "success") {
  if (typeof window === "undefined" || !message) return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}

export function Toast() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [toast, setToast] = useState<ToastState | null>(null);

  // ?toast=<key> after a redirect (sign-in, registration).
  useEffect(() => {
    const key = searchParams.get("toast");
    if (key && MESSAGES[key]) {
      setToast({ id: nextId++, message: MESSAGES[key], tone: "success" });

      // Remove toast param from URL without reload
      const url = new URL(window.location.href);
      url.searchParams.delete("toast");
      navigate(url.pathname + (url.search || ""), { replace: true });
    }
  }, []);

  // showToast() from anywhere on the page.
  useEffect(() => {
    function onToast(e: Event) {
      const detail = (e as CustomEvent<{ message?: string; tone?: ToastTone }>).detail;
      if (!detail?.message) return;
      setToast({
        id: nextId++,
        message: detail.message,
        tone: detail.tone === "error" ? "error" : "success",
      });
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  // Auto-dismiss. A new toast replaces the old one and restarts the timer.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const isError = toast?.tone === "error";

  // animate-slide-in is this project's own keyframe (app/app.css). The
  // tailwindcss-animate utilities this carried before - animate-in,
  // slide-in-from-bottom-4, fade-in - did nothing: that plugin is not
  // installed, so the toast simply appeared with no transition at all.
  //
  // The wrapper is always mounted so screen readers announce new messages.
  return (
    <div className="fixed bottom-6 right-6 z-50" aria-live="polite">
      {toast && (
        <div
          key={toast.id}
          role={isError ? "alert" : "status"}
          className="animate-slide-in flex items-start gap-3 bg-gray-900 text-white px-4 py-3 rounded-xl shadow-2xl border border-white/10 max-w-sm w-[calc(100vw-3rem)] sm:w-auto"
        >
          {isError ? (
            <AlertCircle className="text-red-400 shrink-0 w-5 h-5 mt-px" />
          ) : (
            <CheckCircle2 className="text-green-400 shrink-0 w-5 h-5 mt-px" />
          )}
          <span className="text-sm font-medium flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
            className="text-gray-400 hover:text-white transition-colors shrink-0 mt-0.5"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

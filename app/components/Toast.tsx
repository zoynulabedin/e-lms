import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { CheckCircle2, X } from "lucide-react";

const MESSAGES: Record<string, string> = {
  welcome: "Welcome back! You're signed in.",
  registered: "Account created successfully! Welcome aboard.",
};

export function Toast() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const toast = searchParams.get("toast");
    if (toast && MESSAGES[toast]) {
      setMessage(MESSAGES[toast]);
      setVisible(true);

      // Remove toast param from URL without reload
      const url = new URL(window.location.href);
      url.searchParams.delete("toast");
      navigate(url.pathname + (url.search || ""), { replace: true });

      // Auto-dismiss after 4 seconds
      const timer = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!visible || !message) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center gap-3 bg-gray-900 text-white px-4 py-3 rounded-xl shadow-2xl border border-white/10 max-w-sm">
        <CheckCircle2 className="text-green-400 shrink-0 w-5 h-5" />
        <span className="text-sm font-medium flex-1">{message}</span>
        <button
          onClick={() => setVisible(false)}
          className="text-gray-400 hover:text-white transition-colors shrink-0"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

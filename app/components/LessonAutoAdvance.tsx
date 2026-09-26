import { useEffect, useId, useRef } from "react";
import { Link } from "react-router";
import { AlertCircle, Award, Check, RefreshCw } from "lucide-react";
import type { AutoAdvancePhase } from "../utils/lesson-auto-advance";

const PRIMARY_BTN =
  "rounded-lg bg-brand-mustard px-3.5 py-2 text-[13px] font-semibold text-brand-navy-deeper hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const SECONDARY_BTN =
  "rounded-lg border border-white/20 px-3.5 py-2 text-[13px] font-semibold text-white/80 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** Phases that ask the learner something, and so take focus. */
const INTERACTIVE: ReadonlySet<AutoAdvancePhase> = new Set(["countdown", "manual", "finished", "error"]);

/**
 * The card shown over a Storyline lesson once it reports completion: saving,
 * "Next lesson starts in…", a quiz waiting to be started, the end of the
 * course, or a failed save. It renders state only; the decisions live in
 * useLessonAutoAdvance.
 *
 * Accessibility: when the card needs an answer it takes focus (so keyboard
 * and screen-reader users can cancel inside the countdown) and gives it back
 * on Cancel/Close or Escape. The per-second number is not announced; the
 * dialog's description is read once when focus arrives.
 */
export function LessonAutoAdvance({
  phase,
  secondsLeft,
  error,
  next,
  courseComplete,
  certificateUrl,
  onContinue,
  onCancel,
  onRetry,
}: {
  phase: AutoAdvancePhase;
  secondsLeft: number;
  error: string | null;
  next: { kind: "lesson" | "quiz"; title: string } | null;
  courseComplete: boolean;
  certificateUrl: string;
  onContinue: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const interactive = INTERACTIVE.has(phase);

  useEffect(() => {
    if (!interactive) return;
    const card = cardRef.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !card?.contains(active)) {
      returnFocusRef.current = active;
    }
    card?.querySelector<HTMLElement>("button, a[href]")?.focus();
  }, [phase, interactive]);

  // An element in fullscreen that does not contain the card (Storyline's own
  // fullscreen) would hide it while the countdown runs. Leave fullscreen so
  // the learner can see, and stop, what happens next.
  useEffect(() => {
    if (phase === "idle") return;
    const fullscreen = document.fullscreenElement;
    if (fullscreen && cardRef.current && !fullscreen.contains(cardRef.current)) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [phase]);

  const close = () => {
    onCancel();
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  };

  const nextIsQuiz = next?.kind === "quiz";
  let title = "";
  // `upNext` is the next item's title, shown on one line and truncated.
  let upNext: string | null = null;
  let lines: string[] = [];
  let announcement = "";
  switch (phase) {
    case "saving":
      title = "Saving lesson progress…";
      lines = ["Please wait a moment."];
      announcement = "Lesson finished. Saving your progress.";
      break;
    case "navigating":
      title = nextIsQuiz ? "Opening quiz…" : "Opening next lesson…";
      upNext = next?.title ?? null;
      announcement = next ? `Opening ${next.title}.` : "";
      break;
    case "countdown":
      title = "Lesson complete";
      upNext = next ? `Up next: ${next.title}` : null;
      lines = [`Next lesson starts in ${secondsLeft} ${secondsLeft === 1 ? "second" : "seconds"}.`];
      break;
    case "manual":
      title = "Lesson complete";
      upNext = next ? `Up next: ${next.title}` : null;
      lines = ["Start the quiz when you're ready."];
      break;
    case "finished":
      title = courseComplete ? "Course complete" : "Lesson complete";
      lines = [
        courseComplete
          ? "You've finished every lesson in this course."
          : "This is the last lesson. Anything still unfinished is in the course menu.",
      ];
      break;
    case "error":
      title = "Progress was not saved";
      lines = [error ?? "We couldn't save your lesson progress. Please try again."];
      break;
  }

  return (
    <>
      {/* Present before it has text, so the first message is announced. */}
      <div role="status" className="sr-only">
        {announcement}
      </div>

      {phase !== "idle" && (
        <div
          ref={cardRef}
          role={interactive ? "dialog" : undefined}
          aria-modal={interactive ? false : undefined}
          aria-labelledby={interactive ? titleId : undefined}
          aria-describedby={interactive ? descId : undefined}
          aria-hidden={interactive ? undefined : true}
          onKeyDown={(e) => {
            if (e.key === "Escape" && interactive) {
              e.stopPropagation();
              close();
            }
          }}
          className="absolute right-4 bottom-4 z-20 w-[min(360px,calc(100%-2rem))] rounded-2xl border border-white/15 bg-brand-navy-deeper/95 p-4 text-white shadow-2xl backdrop-blur-sm animate-fade-in"
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-bold text-brand-navy-deeper ${
                phase === "error" ? "bg-red-200" : "bg-brand-mustard"
              }`}
              aria-hidden="true"
            >
              {phase === "countdown" ? (
                <span className="text-lg tabular-nums">{secondsLeft}</span>
              ) : phase === "saving" || phase === "navigating" ? (
                <RefreshCw size={18} className="motion-safe:animate-spin" />
              ) : phase === "error" ? (
                <AlertCircle size={20} />
              ) : (
                <Check size={20} strokeWidth={3} />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p id={titleId} className="text-sm font-semibold">
                {title}
              </p>
              <div id={descId}>
                {upNext && <p className="mt-0.5 truncate text-xs text-white/65">{upNext}</p>}
                {lines.map((line, i) => (
                  <p
                    key={i}
                    className={`mt-1 text-xs leading-relaxed ${phase === "error" ? "text-red-200" : "text-white/80"}`}
                  >
                    {line}
                  </p>
                ))}
              </div>

              {phase === "countdown" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={onContinue} className={PRIMARY_BTN}>
                    Continue Now
                  </button>
                  <button type="button" onClick={close} className={SECONDARY_BTN}>
                    Cancel
                  </button>
                </div>
              )}

              {phase === "manual" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={onContinue} className={PRIMARY_BTN}>
                    Start Quiz
                  </button>
                  <button type="button" onClick={close} className={SECONDARY_BTN}>
                    Close
                  </button>
                </div>
              )}

              {phase === "finished" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {courseComplete && (
                    <Link to={certificateUrl} className={`inline-flex items-center gap-1.5 ${PRIMARY_BTN}`}>
                      <Award size={14} aria-hidden="true" /> Get Certificate
                    </Link>
                  )}
                  <button type="button" onClick={close} className={SECONDARY_BTN}>
                    Close
                  </button>
                </div>
              )}

              {phase === "error" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={onRetry} className={PRIMARY_BTN}>
                    Retry
                  </button>
                  <button type="button" onClick={close} className={SECONDARY_BTN}>
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

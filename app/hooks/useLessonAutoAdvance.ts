import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useNavigation } from "react-router";
import {
  autoAdvanceReducer,
  initialAutoAdvanceState,
  type AutoAdvanceAction,
  type AutoAdvanceState,
  type AutoAdvanceTarget,
} from "../utils/lesson-auto-advance";
import { STORYLINE_AUTO_ADVANCE_SECONDS, storylineDebug } from "../utils/storyline";

/** The item the existing "Next Lesson" button opens. */
export type AutoAdvanceNext = { kind: "lesson" | "quiz"; title: string; url: string };

/** The completion fetcher's state, as the route already has it. */
export type CompletionSaveStatus = {
  state: "idle" | "submitting" | "loading";
  data?: { ok?: boolean; error?: string };
};

const SAVE_FAILED = "We couldn't save your lesson progress. Please try again.";

/**
 * Baseline for a save that joined a request already in flight (the route
 * does not send a second one for the same lesson): whatever the fetcher
 * holds when it is next idle is that request's answer, and so ours.
 */
const JOINED: NonNullable<CompletionSaveStatus["data"]> = {};

const targetOf = (next: AutoAdvanceNext | null): AutoAdvanceTarget => next?.kind ?? "none";

/** Development trace of where a saved completion led. */
function logSaved(s: AutoAdvanceState, next: AutoAdvanceNext | null) {
  if (s.phase === "countdown") storylineDebug("countdown started", { seconds: s.secondsLeft, to: next?.url });
  else if (s.phase === "manual") storylineDebug("next item is a quiz; waiting for the learner", { to: next?.url });
  else if (s.phase === "finished") storylineDebug("no next item; course end reached");
  else if (s.phase === "idle") storylineDebug("saved; staying on this lesson (cancelled or restarted while saving)");
}

/**
 * Storyline completion → saved progress → countdown → next item.
 *
 * The route keeps ownership of everything that already existed: the
 * completion action (`save`, with the fetcher it submits through) and the
 * next-item calculation behind its Next Lesson button (`next`). This hook only
 * sequences them, and guarantees one save and at most one navigation per
 * completion however often Storyline repeats its message.
 */
export function useLessonAutoAdvance({
  lessonId,
  isSaved,
  next,
  save,
  saveStatus,
  paused = false,
  seconds = STORYLINE_AUTO_ADVANCE_SECONDS,
}: {
  /** The Storyline lesson on screen; null turns auto-advance off. */
  lessonId: string | null;
  /** The loader already lists this lesson as completed. */
  isSaved: boolean;
  next: AutoAdvanceNext | null;
  /** The existing lesson-completion submit. */
  save: (lessonId: string) => void;
  saveStatus: CompletionSaveStatus;
  /** Something covers the card (e.g. a drawer): hold the countdown. */
  paused?: boolean;
  seconds?: number;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [state, setState] = useState<AutoAdvanceState>(initialAutoAdvanceState);
  // The lesson `state` belongs to. It catches up in an effect after a lesson
  // change; until then the new lesson renders as idle, never with the card
  // (and live-region text) left over from the lesson before.
  const [stateLesson, setStateLesson] = useState(lessonId);
  const view = stateLesson === lessonId ? state : initialAutoAdvanceState;
  // Transitions run against this ref rather than render state, so two
  // messages that land before React re-renders are still seen in order.
  const stateRef = useRef(state);
  // fetcher.data when the current save began; a different object once the
  // fetcher is idle again is that save's answer.
  const saveStartDataRef = useRef<CompletionSaveStatus["data"]>(undefined);

  // Latest values for handlers that outlive a render (message, timer).
  const latest = useRef({ lessonId, isSaved, next, save, seconds, saveStatus, navigationIdle: true });
  latest.current = {
    lessonId,
    isSaved,
    next,
    save,
    seconds,
    saveStatus,
    navigationIdle: navigation.state === "idle",
  };

  const apply = useCallback((action: AutoAdvanceAction) => {
    const prev = stateRef.current;
    const nextState = autoAdvanceReducer(prev, action);
    if (nextState !== prev) {
      stateRef.current = nextState;
      setState(nextState);
    }
    return nextState;
  }, []);

  const beginSave = useCallback((id: string) => {
    const { state: fetcherState, data } = latest.current.saveStatus;
    saveStartDataRef.current = fetcherState === "idle" ? data : JOINED;
    storylineDebug("lesson completion started", { lessonId: id });
    latest.current.save(id);
  }, []);

  /** Opens the same item the Next Lesson button links to. */
  const open = useCallback(() => {
    const { next: target, navigationIdle } = latest.current;
    if (!target || !navigationIdle) {
      // The learner is already on their way somewhere else (menu, back button).
      storylineDebug("navigation skipped: another navigation is in progress");
      apply({ type: "cancel" });
      return;
    }
    storylineDebug("navigation started", { to: target.url });
    navigate(target.url);
  }, [apply, navigate]);

  const advance = useCallback(
    (type: "tick" | "continue") => {
      const prev = stateRef.current;
      const s = apply({ type });
      if (s.phase === "navigating" && prev.phase !== "navigating") open();
    },
    [apply, open],
  );

  const resolveSaved = useCallback(
    (how: string) => {
      storylineDebug(`lesson completion successful${how}`, { lessonId: latest.current.lessonId });
      const { next: target, seconds: secs } = latest.current;
      logSaved(apply({ type: "saveSucceeded", target: targetOf(target), seconds: secs }), target);
    },
    [apply],
  );

  /** A validated Storyline completion message for `completedLessonId`. */
  const handleCompletion = useCallback(
    (completedLessonId: string) => {
      const { lessonId: current, isSaved: saved, next: target, seconds: secs } = latest.current;
      if (!current || completedLessonId !== current) {
        // A late message from an iframe that is being replaced.
        storylineDebug("completion ignored: not the lesson on screen", { completedLessonId, current });
        return;
      }
      const prev = stateRef.current;
      const s = apply({ type: "completed", alreadySaved: saved, target: targetOf(target), seconds: secs });
      if (s === prev) {
        storylineDebug("duplicate completion ignored", { lessonId: current });
        return;
      }
      if (s.phase === "saving") beginSave(current);
      else {
        storylineDebug("lesson already completed; not saving again", { lessonId: current });
        logSaved(s, target);
      }
    },
    [apply, beginSave],
  );

  const retry = useCallback(() => {
    const id = latest.current.lessonId;
    const prev = stateRef.current;
    if (!id || apply({ type: "retry" }) === prev) return;
    beginSave(id);
  }, [apply, beginSave]);

  const cancel = useCallback(
    (reason = "learner cancelled") => {
      const prev = stateRef.current;
      if (apply({ type: "cancel" }) !== prev) storylineDebug("countdown cancelled", { reason, phase: prev.phase });
    },
    [apply],
  );

  const continueNow = useCallback(() => advance("continue"), [advance]);

  /** The learner is using the card: stop the countdown until they choose. */
  const hold = useCallback(() => {
    const prev = stateRef.current;
    if (apply({ type: "hold" }) !== prev) storylineDebug("countdown held by the learner");
  }, [apply]);

  /** Restarted, or marked incomplete: accept the next completion afresh. */
  const rearm = useCallback(
    (reason = "restarted") => {
      const prev = stateRef.current;
      if (apply({ type: "rearm" }) !== prev) storylineDebug("re-armed", { reason, phase: prev.phase });
    },
    [apply],
  );

  // A new lesson starts with a clean slate.
  useEffect(() => {
    apply({ type: "reset" });
    setStateLesson(lessonId);
  }, [lessonId, apply]);

  // Resolve the save once the existing fetcher has answered and the route has
  // revalidated (it only goes idle after both), so the tick in the menu is
  // already there when the countdown starts.
  useEffect(() => {
    if (view.phase !== "saving" || saveStatus.state !== "idle") return;
    if (saveStatus.data === saveStartDataRef.current) return;
    saveStartDataRef.current = saveStatus.data;
    if (saveStatus.data?.ok) resolveSaved("");
    else {
      storylineDebug("lesson completion failed", { lessonId, error: saveStatus.data?.error });
      apply({ type: "saveFailed", error: saveStatus.data?.error ?? SAVE_FAILED });
    }
  }, [view.phase, saveStatus.state, saveStatus.data, lessonId, apply, resolveSaved]);

  // The loader lists the lesson as complete. While saving, that is the save's
  // answer too (a safety net for the fetcher check above). While the error
  // card is up, the lesson was completed another way (Mark as complete).
  useEffect(() => {
    if (!isSaved) return;
    const phase = stateRef.current.phase;
    if (phase === "saving") resolveSaved(" (confirmed by the loader)");
    else if (phase === "error") cancel("saved another way");
  }, [isSaved, resolveSaved, cancel]);

  // The learner navigated elsewhere (menu, back button, header link) while the
  // card was up. Our own navigation is already in the "navigating" phase; if
  // it ends without leaving the lesson (superseded by a link back to it), the
  // "Opening next lesson…" card must not stay behind.
  useEffect(() => {
    const phase = stateRef.current.phase;
    if (navigation.state === "idle") {
      if (phase === "navigating") cancel("navigation ended on this lesson");
      return;
    }
    if (phase !== "idle" && phase !== "navigating") cancel("learner navigated elsewhere");
  }, [navigation.state, cancel]);

  // A link click (menu, header, logo) cancels before the router renders its
  // navigation, so a last tick in between cannot overtake the learner's choice.
  useEffect(() => {
    if (view.phase !== "countdown") return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || (link.getAttribute("target") || "_self") !== "_self") return;
      cancel("link clicked");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [view.phase, cancel]);

  // Hold the countdown while the tab is hidden, so nobody comes back to find
  // the next lesson already playing.
  const [pageHidden, setPageHidden] = useState(false);
  useEffect(() => {
    const update = () => setPageHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // One timer per second; cleared on every state change and on unmount.
  useEffect(() => {
    if (view.phase !== "countdown" || view.held || pageHidden || paused) return;
    const timer = window.setTimeout(() => advance("tick"), 1_000);
    return () => window.clearTimeout(timer);
  }, [view.phase, view.held, view.secondsLeft, pageHidden, paused, advance]);

  return {
    phase: view.phase,
    secondsLeft: view.secondsLeft,
    held: view.held,
    error: view.error,
    handleCompletion,
    continueNow,
    cancel,
    hold,
    retry,
    rearm,
  };
}

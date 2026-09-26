/**
 * What the course player does after a Storyline lesson reports completion,
 * as a pure state machine. `useLessonAutoAdvance` performs the side effects
 * (saving, timers, navigation); this decides which of them are allowed, so a
 * repeated Storyline message, a double click or a late timer can never save
 * twice or navigate twice.
 *
 * Kept free of imports so it can be exercised without a browser or bundler.
 */

export type AutoAdvancePhase =
  | "idle" //       nothing on screen
  | "saving" //     completion is being saved through the existing action
  | "error" //      the save failed; the learner can retry
  | "countdown" //  saved; the next lesson opens when secondsLeft runs out
  | "manual" //     saved; the next item is a quiz, which the learner starts
  | "finished" //   saved; nothing follows in this course
  | "navigating"; // the next item is being opened

/** What follows the current lesson in the curriculum. */
export type AutoAdvanceTarget = "lesson" | "quiz" | "none";

export type AutoAdvanceState = {
  phase: AutoAdvancePhase;
  /** Accepts a completion signal. Cleared once one is handled this visit. */
  armed: boolean;
  /** Cancelled (or left) while saving: stay put once the save succeeds. */
  stayAfterSave: boolean;
  /** The learner interacted with the countdown card: stop counting. */
  held: boolean;
  secondsLeft: number;
  error: string | null;
};

export type AutoAdvanceAction =
  | { type: "completed"; alreadySaved: boolean; target: AutoAdvanceTarget; seconds: number }
  | { type: "saveSucceeded"; target: AutoAdvanceTarget; seconds: number }
  | { type: "saveFailed"; error: string }
  | { type: "retry" }
  | { type: "tick" }
  | { type: "hold" }
  | { type: "continue" }
  | { type: "cancel" }
  | { type: "rearm" }
  | { type: "reset" };

export const initialAutoAdvanceState: AutoAdvanceState = {
  phase: "idle",
  armed: true,
  stayAfterSave: false,
  held: false,
  secondsLeft: 0,
  error: null,
};

/** The lesson is saved: count down to a lesson, offer a quiz, or finish. */
function afterSave(state: AutoAdvanceState, target: AutoAdvanceTarget, seconds: number): AutoAdvanceState {
  const saved = { ...state, stayAfterSave: false, held: false, error: null };
  if (state.stayAfterSave) return { ...saved, phase: "idle", secondsLeft: 0 };
  // A quiz is never opened automatically: a timed quiz starts its clock the
  // moment it is shown.
  if (target === "quiz") return { ...saved, phase: "manual", secondsLeft: 0 };
  if (target === "none") return { ...saved, phase: "finished", secondsLeft: 0 };
  return { ...saved, phase: "countdown", secondsLeft: Math.max(1, Math.round(seconds)) };
}

export function autoAdvanceReducer(state: AutoAdvanceState, action: AutoAdvanceAction): AutoAdvanceState {
  switch (action.type) {
    case "completed":
      // One completion per lesson visit; Storyline can fire its trigger twice.
      if (!state.armed) return state;
      if (action.alreadySaved) {
        return afterSave({ ...state, armed: false, stayAfterSave: false }, action.target, action.seconds);
      }
      return { ...state, phase: "saving", armed: false, stayAfterSave: false, error: null };

    case "saveSucceeded":
      if (state.phase !== "saving") return state;
      return afterSave(state, action.target, action.seconds);

    case "saveFailed":
      if (state.phase !== "saving") return state;
      return { ...state, phase: "error", stayAfterSave: false, error: action.error };

    case "retry":
      if (state.phase !== "error") return state;
      return { ...state, phase: "saving", error: null };

    case "tick":
      if (state.phase !== "countdown" || state.held) return state;
      if (state.secondsLeft <= 1) return { ...state, phase: "navigating", secondsLeft: 0 };
      return { ...state, secondsLeft: state.secondsLeft - 1 };

    case "hold":
      // Someone reaching for Cancel - by keyboard, switch or screen reader -
      // must not be overtaken by the timer (WCAG 2.2.1).
      if (state.phase !== "countdown" || state.held) return state;
      return { ...state, held: true };

    case "continue":
      if (state.phase !== "countdown" && state.phase !== "manual") return state;
      return { ...state, phase: "navigating", secondsLeft: 0 };

    case "cancel":
      // A save in flight still finishes - progress is never dropped - but the
      // learner is not moved on when it does.
      if (state.phase === "saving") return state.stayAfterSave ? state : { ...state, stayAfterSave: true };
      if (state.phase === "idle") return state;
      return { ...state, phase: "idle", held: false, secondsLeft: 0, error: null };

    case "rearm":
      // The Storyline was restarted (or the lesson marked incomplete), so its
      // next completion is a new one. A save in flight still finishes, but
      // must not start a countdown over the restarted lesson.
      if (state.phase === "navigating") return state;
      if (state.phase === "saving") {
        return state.armed && state.stayAfterSave ? state : { ...state, armed: true, stayAfterSave: true };
      }
      if (state.phase === "idle" && state.armed) return state;
      return initialAutoAdvanceState;

    case "reset":
      return initialAutoAdvanceState;
  }
}

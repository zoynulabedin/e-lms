# Storyline lesson completion → automatic next lesson

A Storyline package only announces **"I have completed."** The LMS decides
everything else: it saves the learner's progress, shows a short countdown and
opens the next item in the course. A Storyline package never contains an LMS
URL, a lesson ID or any navigation logic.

```
Storyline trigger ──postMessage──▶ StorylinePlayer (validates) ──▶ useLessonAutoAdvance
                                                                   │
        existing complete_lesson action ◀── save ──────────────────┤
                                                                   ▼
                        LessonAutoAdvance card: "Next lesson starts in 5…4…3…"
                                                                   │
                        same URL as the existing Next Lesson button ◀┘
```

## 1. The JavaScript to add in Storyline

Paste this into an **Execute JavaScript** trigger, exactly as written:

```javascript
window.parent.postMessage({ type: "STORYLINE_LESSON_COMPLETED" }, "*");
```

- `window.parent` is the LMS course player, because the LMS embeds the
  published `story.html` directly in an iframe.
- The target `"*"` lets the same published package work on local, staging and
  production. The message carries no data, and the LMS decides whether to
  trust it (see section 4).
- Firing it more than once is harmless. The LMS handles one completion per
  lesson visit.

## 2. Where to add it (Storyline 360)

Pick **one** trigger per lesson. Use the one that matches the real end of the
lesson:

| Lesson ends when…                                 | Trigger "When"      | "Object"          |
| ------------------------------------------------- | ------------------- | ----------------- |
| The last slide finishes playing (most lessons)    | **Timeline ends**   | the final slide   |
| A video finishes (video-only lesson)              | **Media completes** | that video        |
| The learner clicks a final button such as "Finish"| **User clicks**     | that button       |

Steps:

1. Open the lesson's **final slide**, or the slide with the lesson's video.
2. In the **Triggers** panel, choose **Create a new trigger**.
3. **Action:** *Execute JavaScript*. Open the *Script* box and paste the
   script from section 1.
4. **When:** choose from the table above, for example *Timeline ends* on
   *this slide*, or *Media completes* on your video.
5. Click **OK**, then **Publish → Web**. Upload the published folder to the
   content host, replacing the old output.

Guidance:

- Put the trigger where the **whole lesson** is finished. If slides, a quiz
  or an interaction follow a video, do not use *Media completes*. Use the
  final slide or the final required action instead. Otherwise the learner is
  moved on before finishing.
- *Timeline ends* does not fire while the slide's timeline is paused, for
  example by a layer that pauses the base layer. If the last slide waits for
  input, use the button's *User clicks* trigger.
- The parent page never inspects the video inside Storyline. Storyline is the
  only thing that knows the video finished, which is why its own *Media
  completes* trigger sends the signal.
- JavaScript triggers **do not run in Storyline's Preview**. Test the
  published output.

## 3. What the LMS does

After a valid message:

1. **Duplicate check.** Only the first completion of this lesson visit is
   used. Repeats are ignored: no second save, countdown or navigation.
2. **Save.** The existing `complete_lesson` action saves the completion, and
   the LMS waits until the save and the progress refresh have finished. If
   the lesson was already complete, no request is sent.
3. **Countdown.** A card shows *Lesson complete*, the next item's title and
   *Next lesson starts in 5 seconds*, with **Continue Now** and **Cancel**.
4. **Navigate.** When the countdown ends, the LMS opens the same item the
   **Next Lesson** button links to. This works across module boundaries: the
   last lesson of Module 1 is followed by the first item of Module 2.

Special cases:

| Situation                        | Behaviour                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Next item is a **quiz**          | No countdown. The card offers **Start Quiz**, because a timed quiz starts its clock as soon as it opens. |
| **Last item** in the course      | No countdown and no navigation. The card shows *Course complete* (with **Get Certificate**) once everything is finished, and otherwise points to the course menu. |
| **Save fails**                   | The learner stays on the lesson. The card shows **Retry**. Next Lesson stays hidden until the completion is saved; the menu and *Mark as complete* still work. |
| Learner presses **Cancel**       | The countdown stops, the completion stays saved and the Next Lesson button is available. The countdown does not restart. |
| Learner navigates during the countdown (menu, Previous/Next, back button) | The countdown is cancelled; the learner's choice wins. |
| Browser tab is hidden            | The countdown pauses until the tab is visible again.                                                  |
| **Restart** button (LMS header)  | Reloads the Storyline and cancels any countdown. The next completion of the restarted lesson counts as new. |
| Storyline is in its own fullscreen | The LMS leaves fullscreen so the countdown card is visible.                                          |

Keyboard and screen-reader users: when the card needs an answer it takes
focus, **Escape** cancels, and the countdown is announced once, not every
second.

## 4. How the message is validated

The LMS acts on a message only if **all** of these hold:

1. It was sent by the window inside **this lesson's** Storyline iframe.
   Messages from other frames, tabs or browser extensions are ignored.
2. Its origin is the origin of the lesson's **embed URL**, or one listed in
   `STORYLINE_ALLOWED_ORIGINS`.
3. Its payload is exactly `{ type: "STORYLINE_LESSON_COMPLETED" }`, or the
   older `{ action: "lessonComplete" }`. A JSON string of either is also
   accepted.
4. The lesson it belongs to is still the lesson on screen, so a late message
   from a lesson being left is ignored.

The server still checks the learner's licence and that the lesson belongs to
the course, as for any completion.

## 5. Configuration

| Setting | Where | Default |
| ------- | ----- | ------- |
| `STORYLINE_ALLOWED_ORIGINS` | Server environment (optional). A comma-separated list of extra origins, e.g. `https://cdn.example.com`. Needed only if the published `story.html` is served from a different host than the embed URL (for example after a redirect). | *(empty)*: only each embed URL's own origin is accepted. |
| Countdown length | `STORYLINE_AUTO_ADVANCE_SECONDS` in `app/utils/storyline.ts` | `5` |

The embed URL itself is the existing **Storyline embed URL** field of the
lesson in the course builder.

## 6. Testing

### Turn on the trace

In development builds the trace is always on. On staging or production, turn
it on for your own browser only by running this in the DevTools console of
the course player:

```javascript
localStorage.setItem("storyline-debug", "1"); // remove the key to turn it off
```

Reload. The console then shows `[storyline] …` lines such as
*completion event received*, *duplicate completion ignored*,
*message rejected: origin not allowed*, *lesson completion started /
successful / failed*, *countdown started*, *countdown cancelled* and
*navigation started*.

### Without republishing Storyline

To simulate the trigger:

1. Open a Storyline lesson in the course player.
2. In DevTools, set the console's **JavaScript context** dropdown to the
   Storyline frame (`story.html`).
3. Run the script from section 1.

It is exactly what the trigger does, so it exercises the real validation.
The same line run in the **top** context is ignored, because it does not come
from the iframe.

### With a published package

1. Publish a short test lesson (**Publish → Web**) with the trigger on its
   final slide, and upload it.
2. In the course builder, add it as a *Storyline* lesson whose next item is
   another lesson.
3. Open it as a student with access and play to the end. You should see, in
   order: *Saving lesson progress…*, then *Lesson complete*, then the
   countdown 5 → 1, then the next lesson opens. The menu shows the green tick
   on the finished lesson.

### Checklist

- [ ] Countdown, **Continue Now**, **Cancel**. After Cancel, the Next Lesson
      button works.
- [ ] Trigger fires twice: only one save request (Network tab) and one countdown.
- [ ] Last lesson of a module: the first item of the next module opens.
- [ ] Next item is a quiz: **Start Quiz** is offered and nothing opens by itself.
- [ ] Last lesson of the course: no countdown, end-of-course card.
- [ ] Save failure: **Retry** is shown and the page does not navigate. To
      test, stop the server or go offline in DevTools just before the end.
- [ ] Previous / Next / menu clicked during the countdown: the learner's
      choice wins.
- [ ] Refresh a completed lesson: Next Lesson is visible and nothing
      auto-advances until the lesson reports completion again.
- [ ] Video lesson with a *Media completes* trigger.
- [ ] A package **without** the script: no card appears. *Mark as complete*
      reveals Next Lesson, and the menu works as before.

## 7. Compatibility

- Packages published with the older `{ action: "lessonComplete" }` trigger
  keep working, including auto-advance.
- Packages without any completion trigger behave as before. Nothing
  auto-advances. For a Storyline lesson, *Next Lesson* appears once the
  learner uses *Mark as complete*; *Previous Lesson* and the menu always
  work.
- Flat (module-less) Storyline courses are unchanged. They track the watch
  percentage from `{ type: "progress", percent }` messages and have no next
  lesson.

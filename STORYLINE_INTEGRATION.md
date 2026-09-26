# Storyline lesson-completion integration

The LMS controls progress, the countdown, and lesson navigation. A Storyline
package only reports that its lesson has finished; it must not contain an LMS
lesson URL or try to choose the next lesson itself.

## JavaScript to add in Storyline

Add an **Execute JavaScript** trigger containing:

```javascript
window.parent.postMessage(
  { type: "STORYLINE_LESSON_COMPLETED" },
  "*"
);
```

`"*"` is used by the sender so the same published package works on local,
staging, and production LMS hosts. The LMS receiver does not trust arbitrary
messages: it accepts the event only when it comes from the currently embedded
Storyline iframe and its exact configured content origin, and only while that
Storyline lesson is current.

Older packages that already send `{ action: "lessonComplete" }` remain
supported, but all new packages should use `STORYLINE_LESSON_COMPLETED`.

## Where to put the trigger

In Articulate Storyline:

1. Open the final slide of the lesson.
2. Create a trigger with action **Execute JavaScript**.
3. Paste the JavaScript above.
4. Run it when the final slide's timeline completes, or on the final action the
   learner must perform.
5. Publish the package and upload/replace the hosted Storyline output.

The trigger should represent completion of the whole lesson. Do not attach it
to an early slide merely because that slide contains a video.

For a video-only lesson, Storyline may run the same JavaScript when that media
completes. If content or interactions follow the video, run it on the final
slide or final required interaction instead.

## What happens in the LMS

After a valid event, the LMS:

1. Ignores any duplicate completion events.
2. Saves completion through the existing `complete_lesson` action.
3. Waits for the save and progress recalculation to succeed.
4. Displays a five-second countdown.
5. Opens the next lesson, including a lesson in the next module.

The learner can select **Continue Now** or **Cancel**. Canceling leaves the
saved completion intact and keeps the existing manual navigation available.
If saving fails, the LMS stays on the current lesson and offers **Retry**.
When there is no later lesson, it displays the course-complete state instead
of starting a countdown.

## Testing

1. Publish a short test lesson with the trigger on its final slide.
2. Configure that package as a Storyline lesson followed by another lesson.
3. Open it as a licensed student and reach the final slide.
4. Confirm that **Saving lesson progress…** appears before the countdown.
5. Confirm that the lesson receives its completed indicator.
6. Test **Continue Now**, **Cancel**, and normal countdown completion.
7. Fire the Storyline trigger twice and confirm there is only one save and one
   countdown.
8. Test the last lesson in a module and verify that the first lesson in the next
   module opens.
9. Test the final lesson in a course and verify that no navigation is attempted.
10. Repeat against staging and production after each environment's Storyline
    embed URL is configured.

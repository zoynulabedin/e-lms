# Storyline Auto-Advance Feature Implementation

## 🎯 Goal

Implement an auto-advance feature for the e-LMS platform where Storyline 360 lessons (embedded via iframe) automatically advance to the next lesson when complete, with a 5-second countdown overlay that the learner can override.

## 📋 Context

This is a **React Router v7** (Remix evolution) project with **TypeScript**, **Prisma**, **Tailwind CSS**.

**Course architecture:**

```
courses.instructionalgraphics.org/
└── FBC2024/                           ← Course
    └── Module1/                       ← Module
        └── Financial_Goals/           ← Lesson
            ├── story.html             ← iframe loads this
            ├── story_content/
            ├── html5/
            ├── mobile/
            ├── analytics-frame.html
            ├── launcher.html
            └── meta.xml
```

**How it works:**

1. The Storyline course (inside the iframe) sends a `postMessage` to the parent window when the last slide's timeline ends.
2. The parent React Router app listens for that message.
3. A 5-second countdown overlay appears with "Continue Now" and "Stay Here" buttons.
4. At zero, navigate to the next lesson using React Router's `navigate()`.
5. Save lesson completion to the database via Prisma.

**Why postMessage?** Storyline runs inside an iframe under a different origin (`courses.instructionalgraphics.org`), so cross-origin security blocks direct function calls. `window.postMessage` is the standard, safe communication channel between iframe and parent.

---

## 🔍 Pre-Implementation Investigation

Before writing any code, **read these files** in the existing project to understand the current structure:

1. `app/routes.ts` — to see how routes are configured
2. `app/routes/` directory — find the existing lesson player route (likely `courses.$courseId.lessons.$lessonId.tsx` or similar)
3. `prisma/schema.prisma` — check the `Lesson` model fields
4. `app/app.css` or wherever Tailwind directives are imported
5. Any existing iframe usage to understand current patterns
6. `app/lib/` or `app/utils/` for existing helpers (Prisma client, auth, etc.)

**Report findings to the user** before making changes — confirm:

- Exact path of the lesson route file
- Whether `Lesson` model has a field for the Storyline path (e.g., `storylinePath`, `iframeUrl`, `contentUrl`)
- Whether there's an existing progress tracking API route
- The current way `next lesson` is determined (DB order? array? hardcoded?)

---

## 📦 Implementation Tasks

### Task 1: Create Reusable StorylinePlayer Component

**Path:** `app/components/StorylinePlayer.tsx`

**Requirements:**

- Accept `src`, `lessonId`, `nextLessonUrl`, `onComplete`, and `allowedOrigin` props
- Render an iframe with the Storyline course
- Listen for `postMessage` events with `action: 'lessonComplete'`
- **Validate `event.origin`** against `allowedOrigin` (security)
- Show a fixed-position countdown overlay (bottom-right corner)
- Tick down from 5 seconds, with "Continue Now" and "Stay Here" buttons
- Auto-navigate using React Router's `useNavigate()` at zero
- Call `onComplete(lessonId)` callback for DB progress tracking
- Clean up event listeners on unmount

**Code:**

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

interface StorylinePlayerProps {
  /** Full URL of the Storyline story.html */
  src: string;
  /** Lesson ID for tracking — e.g., "FBC2024/Module1/Financial_Goals" */
  lessonId: string;
  /** Where to navigate when lesson completes — null = no auto-advance */
  nextLessonUrl: string | null;
  /** Callback when lesson completes (for progress tracking in DB) */
  onComplete?: (lessonId: string) => void;
  /** Allowed origin for postMessage security */
  allowedOrigin?: string;
}

export default function StorylinePlayer({
  src,
  lessonId,
  nextLessonUrl,
  onComplete,
  allowedOrigin = "https://courses.instructionalgraphics.org",
}: StorylinePlayerProps) {
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Security: only accept messages from your Storyline host
      if (event.origin !== allowedOrigin) return;

      const data = event.data;
      if (!data || data.action !== "lessonComplete") return;

      console.log("✅ Lesson complete:", data.lessonPath || lessonId);

      // Save progress to DB (calls onComplete callback)
      onComplete?.(lessonId);

      // Start 5-second countdown
      if (nextLessonUrl) {
        setCountdown(5);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [lessonId, nextLessonUrl, allowedOrigin, onComplete]);

  // Countdown ticker
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      if (nextLessonUrl) navigate(nextLessonUrl);
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, nextLessonUrl, navigate]);

  return (
    <div className="relative w-full h-full">
      <iframe
        src={src}
        title="Storyline Course"
        className="w-full h-full border-0"
        allow="autoplay; fullscreen"
      />

      {/* Countdown Overlay */}
      {countdown !== null && countdown > 0 && (
        <div className="fixed bottom-8 right-8 z-[9999] animate-slide-in">
          <div className="bg-black/85 text-white px-7 py-5 rounded-xl shadow-2xl text-center min-w-[280px]">
            <p className="text-sm text-gray-300 mb-1">
              Next lesson starting in...
            </p>
            <div className="text-5xl font-bold text-red-500 my-2 leading-none">
              {countdown}
            </div>
            <div className="flex gap-2 justify-center mt-3">
              <button
                onClick={() => {
                  if (nextLessonUrl) navigate(nextLessonUrl);
                }}
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium transition"
              >
                Continue Now →
              </button>
              <button
                onClick={() => setCountdown(null)}
                className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-md text-sm font-medium transition"
              >
                Stay Here
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

### Task 2: Add Slide-In Animation CSS

**Path:** `app/app.css` (or wherever Tailwind directives live)

Add to the **end** of the file:

```css
@keyframes slide-in {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.animate-slide-in {
  animation: slide-in 0.3s ease-out;
}
```

---

### Task 3: Update Lesson Player Route

**Path:** Find the existing lesson route file (likely under `app/routes/`).

Replace the current iframe usage with the `<StorylinePlayer />` component.

**Template (adapt to existing route structure):**

```tsx
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import StorylinePlayer from "~/components/StorylinePlayer";
import { prisma } from "~/lib/prisma.server"; // adjust to actual Prisma client path
import { getNextLesson } from "~/lib/lesson-navigation.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const { courseId, lessonId } = params;

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    include: { module: { include: { course: true } } },
  });

  if (!lesson) throw new Response("Not Found", { status: 404 });

  const next = await getNextLesson(lesson);

  return {
    lesson,
    storylineSrc: `https://courses.instructionalgraphics.org/${lesson.storylinePath}/story.html`,
    nextLessonUrl: next
      ? `/courses/${courseId}/lessons/${next.id}`
      : `/courses/${courseId}/complete`,
  };
}

export default function LessonPage() {
  const { lesson, storylineSrc, nextLessonUrl } =
    useLoaderData<typeof loader>();

  async function markComplete(lessonId: string) {
    await fetch(`/api/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId, completed: true }),
    });
  }

  return (
    <div className="w-full h-screen">
      <StorylinePlayer
        src={storylineSrc}
        lessonId={lesson.id}
        nextLessonUrl={nextLessonUrl}
        onComplete={markComplete}
      />
    </div>
  );
}
```

**Important:** Adapt loader to match the actual Prisma schema. If the field is named differently (e.g., `iframeUrl`, `contentPath`), update accordingly.

---

### Task 4: Create `getNextLesson` Helper

**Path:** `app/lib/lesson-navigation.server.ts`

Returns the next lesson in sequence based on module + lesson order.

```ts
import { prisma } from "./prisma.server"; // adjust path

type LessonWithModule = {
  id: string;
  order: number;
  moduleId: string;
  module: {
    id: string;
    order: number;
    courseId: string;
  };
};

export async function getNextLesson(currentLesson: LessonWithModule) {
  // Try next lesson in same module
  const nextInModule = await prisma.lesson.findFirst({
    where: {
      moduleId: currentLesson.moduleId,
      order: { gt: currentLesson.order },
    },
    orderBy: { order: "asc" },
  });

  if (nextInModule) return nextInModule;

  // Try first lesson of next module in same course
  const nextModule = await prisma.module.findFirst({
    where: {
      courseId: currentLesson.module.courseId,
      order: { gt: currentLesson.module.order },
    },
    orderBy: { order: "asc" },
    include: {
      lessons: { orderBy: { order: "asc" }, take: 1 },
    },
  });

  return nextModule?.lessons[0] ?? null;
}
```

**If the schema doesn't have `order` fields**, add them in a Prisma migration first, or use `createdAt` as a fallback ordering.

---

### Task 5: Create Progress Tracking API Route

**Path:** `app/routes/api.progress.tsx` (only if it doesn't already exist)

```tsx
import type { ActionFunctionArgs } from "react-router";
import { prisma } from "~/lib/prisma.server";
import { requireUser } from "~/lib/auth.server"; // adjust to actual auth helper

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const { lessonId, completed } = await request.json();

  const progress = await prisma.lessonProgress.upsert({
    where: {
      userId_lessonId: { userId: user.id, lessonId },
    },
    update: {
      completed,
      completedAt: completed ? new Date() : null,
    },
    create: {
      userId: user.id,
      lessonId,
      completed,
      completedAt: completed ? new Date() : null,
    },
  });

  return { success: true, progress };
}
```

**Required Prisma model** (add if missing):

```prisma
model LessonProgress {
  id          String   @id @default(cuid())
  userId      String
  lessonId    String
  completed   Boolean  @default(false)
  completedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  lesson Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@unique([userId, lessonId])
  @@index([userId])
  @@index([lessonId])
}
```

After adding/changing the model:

```bash
npx prisma migrate dev --name add_lesson_progress
npx prisma generate
```

---

### Task 6: Storyline-Side Trigger (Manual — Outside Codebase)

This step is **not part of the codebase** but is required for the feature to work. Document it in the project README so the content team knows.

In Storyline 360, on the **last slide** of every lesson:

1. Open Triggers panel → **Create new trigger**
2. **Action:** Execute JavaScript
3. **When:** Timeline ends
4. **Object:** This slide
5. Paste:

```javascript
window.parent.postMessage(
  {
    action: "lessonComplete",
    lessonPath: window.location.pathname
      .replace("/story.html", "")
      .replace(/^\//, ""),
  },
  "*",
);
```

6. Save → Publish (Web format) → Upload to cPanel.

**Same snippet works for every lesson** — `window.location.pathname` auto-detects the lesson identifier from the URL.

---

## 🧪 Testing Checklist

After implementation:

- [ ] Component compiles without TypeScript errors
- [ ] Lesson route loads and iframe renders the Storyline course
- [ ] Open browser DevTools → Console — verify message logging works when last slide ends
- [ ] Countdown overlay appears in bottom-right corner after `lessonComplete` message
- [ ] "Continue Now" button navigates immediately to next lesson
- [ ] "Stay Here" button cancels countdown without navigating
- [ ] At countdown = 0, automatic navigation happens
- [ ] Progress is saved to DB (check `LessonProgress` table)
- [ ] On the last lesson of a course, navigate to course-complete page (no next lesson)
- [ ] Test on the actual published Storyline course (not preview — postMessage doesn't fire reliably in Storyline preview)
- [ ] Verify `event.origin` security check is working — try sending a fake message from console with a different origin and confirm it's rejected

---

## 🚨 Common Issues & Debugging

### Issue: Countdown never appears

- **Check:** Storyline trigger was added on the **last slide only**, on **"Timeline ends"**, as **Execute JavaScript** (not as text variable).
- **Check:** The course was **published**, not just previewed. postMessage doesn't fire in Storyline preview mode.
- **Check:** Console shows the message arriving. If not, the trigger isn't firing or the iframe origin doesn't match `allowedOrigin`.

### Issue: Countdown appears but doesn't advance

- **Check:** `nextLessonUrl` is being computed correctly in the loader. `console.log` it.
- **Check:** `getNextLesson` is returning the correct next lesson, not `null`.

### Issue: Origin check rejects all messages

- **Check:** `allowedOrigin` exactly matches the Storyline host (no trailing slash, correct protocol).
- For local development, may need to allow `http://localhost:*` temporarily — but **never** ship that to production.

### Issue: Progress not saving

- **Check:** User is authenticated when calling `/api/progress`.
- **Check:** `LessonProgress` model exists and migration ran.
- **Check:** Network tab in DevTools — is the request returning 200?

---

## 🔐 Security Notes

1. **Always validate `event.origin`** in the message listener. Without this, any malicious page could send a `lessonComplete` message and skip learners forward, breaking progress tracking.

2. **Never use `'*'` as the target origin in production postMessage** from Storyline. Once everything works, change Storyline's snippet to:

   ```javascript
   window.parent.postMessage({...}, 'https://your-lms-domain.com');
   ```

3. **Lock down iframe permissions** if Storyline doesn't need them all:

   ```tsx
   <iframe ... sandbox="allow-scripts allow-same-origin" />
   ```

   Test this carefully — Storyline may need additional sandbox permissions.

4. **Authenticate the progress API** — never let anonymous users mark lessons complete.

---

## 📁 File Summary

| File                                  | Action                             | Purpose                                   |
| ------------------------------------- | ---------------------------------- | ----------------------------------------- |
| `app/components/StorylinePlayer.tsx`  | Create                             | Reusable iframe + countdown component     |
| `app/app.css`                         | Edit                               | Add slide-in animation keyframes          |
| `app/routes/[lesson route].tsx`       | Edit                               | Use StorylinePlayer instead of raw iframe |
| `app/lib/lesson-navigation.server.ts` | Create                             | `getNextLesson` helper                    |
| `app/routes/api.progress.tsx`         | Create (if missing)                | Save lesson completion                    |
| `prisma/schema.prisma`                | Edit (if `LessonProgress` missing) | Add progress model                        |
| Storyline `.story` files              | Manual edit (outside repo)         | Add postMessage trigger to last slide     |

---

## 🎯 Implementation Order (Recommended)

1. **Investigate first** — read the files listed in the "Pre-Implementation Investigation" section and report findings.
2. **Confirm with user** — verify the lesson route path, schema, and any naming differences before writing code.
3. **Prisma changes first** — if `LessonProgress` or `order` fields are missing, do migrations before code.
4. **Helpers** — `lesson-navigation.server.ts`.
5. **Component** — `StorylinePlayer.tsx`.
6. **CSS** — animation in `app.css`.
7. **Route updates** — lesson route + progress API.
8. **Test** — run `npm run dev`, test in browser with one lesson.
9. **Document** — update project README with the Storyline-side trigger snippet for the content team.

---

## ❓ Questions to Ask the User Before Coding

1. What is the exact path of the current lesson player route file?
2. What field in the `Lesson` Prisma model holds the Storyline path/URL? (e.g., `storylinePath`, `iframeUrl`, `contentUrl`)
3. Does `LessonProgress` model already exist? If yes, what fields?
4. What is the URL pattern for navigating between lessons? (e.g., `/courses/:courseId/lessons/:lessonId` or different?)
5. Is there an existing auth helper (e.g., `requireUser`)? What's its path?
6. Where is the Prisma client instantiated? (`app/lib/prisma.server.ts`? `app/db.server.ts`?)

Get answers to these **before** writing code to avoid rework.
